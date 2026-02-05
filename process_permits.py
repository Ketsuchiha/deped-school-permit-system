import os
import re
import sys
import json
import pdfplumber # type: ignore
import pytesseract
from pdf2image import convert_from_path
from PIL import Image, ImageOps, ImageEnhance


class SchoolPermitProcessor:
    def __init__(self, file_path):
        self.file_path = file_path
        self.text = ""
        self.extracted_data = {
            "school_name": "",
            "address": "",
            "permits": []
        }

    def process(self):
        """Main processing flow"""
        if not os.path.exists(self.file_path):
            return {"error": "File not found"}

        print(f"Processing: {self.file_path}")
        
        # 1. Extract Text
        self.extract_text()
        
        if not self.text.strip():
            return {"error": "No text could be extracted"}

        # 2. Clean Text
        self.clean_text()

        # 3. Extract School Details
        self.extract_school_details()

        # 4. Extract Permits
        self.extract_permits()

        return self.extracted_data

    def extract_text(self):
        """Extracts text from PDF (with OCR fallback) or Image"""
        ext = os.path.splitext(self.file_path)[1].lower()
        
        if ext == '.pdf':
            self._process_pdf()
        elif ext in ['.jpg', '.jpeg', '.png', '.bmp']:
            self._process_image()
        else:
            print(f"Unsupported file type: {ext}")

    def _process_image(self):
        try:
            image = Image.open(self.file_path)
            # Preprocess
            image = self._preprocess_image(image)
            self.text = pytesseract.image_to_string(image)
        except Exception as e:
            print(f"Image OCR Error: {e}")

    def _preprocess_image(self, image):
        # Convert to grayscale
        image = ImageOps.grayscale(image)
        # Increase contrast
        enhancer = ImageEnhance.Contrast(image)
        image = enhancer.enhance(2.0)
        return image

    def _process_pdf(self):
        try:
            # Try text extraction first
            with pdfplumber.open(self.file_path) as pdf:
                # Limit to first 10 pages
                pages = pdf.pages[:10]
                extracted_pages = []
                
                for i, page in enumerate(pages):
                    text = page.extract_text() or ""
                    
                    # If text is too sparse (< 50 chars), assume scanned and use OCR
                    if len(text.replace(" ", "").strip()) < 50:
                        print(f"Page {i+1} seems scanned. Using OCR...")
                        try:
                            # Convert page to image
                            images = convert_from_path(self.file_path, first_page=i+1, last_page=i+1)
                            if images:
                                # Preprocess
                                processed_img = self._preprocess_image(images[0])
                                text = pytesseract.image_to_string(processed_img)
                        except Exception as e:
                            print(f"Page {i+1} OCR failed: {e}")
                    
                    extracted_pages.append(text)
                
                self.text = "\n".join(extracted_pages)
        except Exception as e:
            print(f"PDF Processing Error: {e}")

    def clean_text(self):
        """Cleans signatures and focuses on relevant content"""
        # Prioritize Header
        header_match = re.search(r'(?:GOVERNMENT\s+(?:RECOGNITION|PERMIT)|AUTHORITY\s+TO\s+OPERATE)', self.text, re.IGNORECASE)
        if header_match:
            self.text = self.text[header_match.start():]

        # Remove Signatures (cutoff text after these markers)
        signature_markers = [
            r'Approved\s+by:',
            r'Signed\s+by:',
            r'Recommending\s+Approval:',
            r'By\s+Authority\s+of\s+the\s+Secretary:',
            r'Schools\s+Division\s+Superintendent',
            r'Regional\s+Director',
            r'Digitally\s+signed'
        ]
        
        for marker in signature_markers:
            match = re.search(marker, self.text, re.IGNORECASE)
            if match:
                self.text = self.text[:match.start()].strip()
                break

    def extract_school_details(self):
        lines = [l.strip() for l in self.text.split('\n') if l.strip()]
        
        # --- School Name ---
        found_name = ""
        
        # Strategy 1: "To [Name]" Pattern with stricter checks
        # Matches "To: SCHOOL NAME" or "Issued to: SCHOOL NAME"
        to_match = re.search(r'(?:^|\n)(?:To|Issued\s+to|Granted\s+to|Name\s+of\s+School)[:\s]*\n*([A-Z0-9\s.,&\'-]+?)(?:\n+\(School\)|\s+located\s+at|\s+to\s+operate|\s+for\s+the|\n|$)', self.text, re.IGNORECASE)
        if to_match:
            candidate = to_match.group(1).strip()
            # Ignore if it looks like a person's name or title unless it has school keywords
            if 'Regional Director' not in candidate and 'Superintendent' not in candidate:
                if len(candidate) > 3:
                    found_name = candidate

        # Strategy 2: "The [Name] located at" Pattern
        if not found_name:
            the_match = re.search(r'(?:The|That)\s+([A-Z0-9\s.,&\'-]+?)\s+located\s+at', self.text, re.IGNORECASE)
            if the_match:
                found_name = the_match.group(1).strip()

        # Strategy 3: Explicit Labels "(School)" or "School Name:"
        if not found_name:
            for i, line in enumerate(lines):
                if re.search(r'\(School\)', line, re.IGNORECASE) or re.search(r'\(Name of School\)', line, re.IGNORECASE):
                    if i > 0:
                        prev_line = lines[i-1]
                        if prev_line and not re.match(r'^To$', prev_line, re.IGNORECASE) and len(prev_line) > 3:
                            found_name = prev_line
                            break
        
        # Fallback: Keywords in all caps lines
        if not found_name:
            school_keywords = ['School', 'Academy', 'College', 'Institute', 'University', 'Montessori', 'Learning Center', 'Lyceum']
            ignored_prefixes = r'^(Respectfully|This\s+permit|Pursuant|Republic|Department|Region|Division|Office|Subject|To:|From:)'
            
            for line in lines:
                if re.match(ignored_prefixes, line, re.IGNORECASE): continue
                if len(line) > 80 or '...' in line: continue
                
                # Check if line has school keyword and is significant
                if any(k in line for k in school_keywords):
                    found_name = line
                    break

        if found_name:
            # Cleanup Name
            prefix_match = re.search(r'(?:Administrator|Principal|Head|Director)\s+of\s+(?:the\s+)?(.*)', found_name, re.IGNORECASE)
            if prefix_match:
                found_name = prefix_match.group(1).strip()
            
            found_name = re.sub(r'^Respectfully\s+endorsed\s+to\s+', '', found_name, flags=re.IGNORECASE)
            found_name = re.sub(r'[,.]+$', '', found_name)
            self.extracted_data['school_name'] = found_name

        # --- Address ---
        found_address = ""
        
        # Strategy 1: "located at" or "situated at"
        located_match = re.search(r'(?:located|situated)\s+at\s+([A-Z0-9\s.,&\'-]+?)(?:\s+(?:approving|approves|granting|granted|hereby|which|where|to\s+operate|subject\s+to|pursuant|under|following|\(School\))|$)', self.text, re.IGNORECASE)
        if located_match:
            found_address = located_match.group(1).strip()
            found_address = re.sub(r'[.,;:]+$', '', found_address)

        # Strategy 2: Explicit Labels "Address:"
        if not found_address:
             addr_match = re.search(r'(?:Address|Location)[:\s]*\s+([A-Z0-9\s.,&\'-]+?)(?:\n|$)', self.text, re.IGNORECASE)
             if addr_match:
                 found_address = addr_match.group(1).strip()

        # Strategy 3: Lines below (Address)
        if not found_address:
            for i, line in enumerate(lines):
                if re.search(r'\(Complete Address\)', line, re.IGNORECASE) or re.search(r'\(Address\)', line, re.IGNORECASE):
                    if i > 0:
                        prev_line = lines[i-1]
                        if prev_line and prev_line != found_name:
                            found_address = prev_line
                            break

        if found_address:
            self.extracted_data['address'] = found_address


    def extract_permits(self):
        text = self.text.replace('\n', ' ').strip()
        # Collapse multiple spaces
        text = re.sub(r'\s+', ' ', text)
        
        permits = []

        # --- Strategy 1: Government Permit Pattern ---
        # Matches: "Government Permit ... No. K - 123 s. 2024"
        gp_pattern = r'(?:Government\s+Permit|GP|Provisional\s+Permit|Authority\s+to\s+Operate|DepEd\s+Permit)(?:\s+\(Region\s+[IVX\d\w-]+\))?\s+(?:No\.?|Number)\s*([A-Z0-9\s-]+)\s*(?:s\.?|series\s+of)\s*(\d{4})'
        
        for match in re.finditer(gp_pattern, text, re.IGNORECASE):
            p_num = match.group(1).replace(" ", "").strip()
            s_year = match.group(2).strip()
            
            if len(p_num) > 20: continue # Garbage check

            permits.append(self._build_permit_object(p_num, s_year, match.start(), text))

        # --- Strategy 2: Government Recognition Pattern ---
        gr_pattern = r'Government\s+Recognition\s+(?:No\.?|Number)?\s*([A-Z0-9\s-]+)?\s*(?:s\.?|series\s+of)\s*(\d{4})'
        for match in re.finditer(gr_pattern, text, re.IGNORECASE):
            p_num = match.group(1).replace(" ", "").strip() if match.group(1) else 'Gov. Rec.'
            s_year = match.group(2).strip()
            
            if len(p_num) > 20: continue

            permits.append(self._build_permit_object(p_num, s_year, match.start(), text))

        # --- Strategy 3: Loose "No. X-Y s. Z" ---
        loose_pattern = r'(?:No\.?|Number)\s*(K-\s*\d+|E-\s*\d+|JHS-\s*\d+|SHS-\s*\d+|S-\s*\d+)\s*(?:s\.?|series\s+of)\s*(\d{4})'
        for match in re.finditer(loose_pattern, text, re.IGNORECASE):
            p_num = match.group(1).replace(" ", "").strip()
            s_year = match.group(2).strip()
            
            # Check for duplicates
            if not any(p['permit_number'] == p_num for p in permits):
                permits.append(self._build_permit_object(p_num, s_year, match.start(), text))

        self.extracted_data['permits'] = permits

    def _build_permit_object(self, p_num, s_year, index, full_text):
        levels = []
        strands = []
        
        # Infer Level from Permit Number Prefix
        if re.search(r'^K[-]', p_num, re.IGNORECASE): levels.append('Kindergarten')
        elif re.search(r'^E[-]', p_num, re.IGNORECASE): levels.append('Elementary')
        elif re.search(r'^(S[-]|JHS[-])', p_num, re.IGNORECASE): levels.append('Junior High School')
        elif re.search(r'^SHS[-]', p_num, re.IGNORECASE): levels.append('Senior High School')

        # Context fallback (look around the match)
        context_start = max(0, index - 300)
        context_end = min(len(full_text), index + 300)
        context = full_text[context_start:context_end]

        if not levels:
            if re.search(r'Kindergarten', context, re.IGNORECASE): levels.append('Kindergarten')
            if re.search(r'Elementary', context, re.IGNORECASE): levels.append('Elementary')
            if re.search(r'Junior\s*High', context, re.IGNORECASE): levels.append('Junior High School')
            if re.search(r'Senior\s*High', context, re.IGNORECASE): levels.append('Senior High School')
            
            # Specific Grades Check
            if re.search(r'Grades?\s+1', context, re.IGNORECASE): levels.append('Elementary')
            if re.search(r'Grades?\s+7', context, re.IGNORECASE): levels.append('Junior High School')
            if re.search(r'Grades?\s+11', context, re.IGNORECASE): levels.append('Senior High School')
        
        levels = list(set(levels))

        # Detect Strands if SHS
        if 'Senior High School' in levels:
            wide_context = full_text[max(0, index - 500):min(len(full_text), index + 500)]
            strands = self._detect_strands(wide_context)

        return {
            "permit_number": p_num,
            "school_year": s_year,
            "levels": levels,
            "strands": strands
        }

    def _detect_strands(self, text):
        found = []
        if re.search(r'STEM|Science,? Technology,? Engineering,? (?:and|&) Mathematics', text, re.IGNORECASE): found.append('STEM')
        if re.search(r'ABM|Accountancy,? Business,? (?:and|&) Management', text, re.IGNORECASE): found.append('ABM')
        if re.search(r'HUMSS|Humanities (?:and|&) Social Sciences', text, re.IGNORECASE): found.append('HUMSS')
        if re.search(r'GAS|General Academic', text, re.IGNORECASE): found.append('GAS')
        if re.search(r'TVL|Technical[- ]Vocational[- ]Livelihood', text, re.IGNORECASE): found.append('TVL')
        if re.search(r'Sports', text, re.IGNORECASE): found.append('Sports')
        if re.search(r'Arts (?:and|&) Design', text, re.IGNORECASE): found.append('Arts and Design')
        return found

# Example Usage
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python process_permits.py <path_to_file>")
        sys.exit(1)
    
    file_path = sys.argv[1]
    processor = SchoolPermitProcessor(file_path)
    result = processor.process()
    
    print("\n--- Extraction Result ---")
    print(json.dumps(result, indent=2))
