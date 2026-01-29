<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { Shield, Home, Building2, Search, Plus, Upload, Calendar, FileImage, Loader2, CheckCircle, XCircle, BarChart3, PieChart, LayoutDashboard } from 'lucide-vue-next'
import Tesseract from 'tesseract.js'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import CustomSelect from './components/CustomSelect.vue'

GlobalWorkerOptions.workerSrc = workerSrc

// ─── View state ─────────────────────────────────────────────────────────────
const currentView = ref('search') // 'search' | 'admin'

const API_URL = 'http://localhost:3000/api'

const showSummary = ref(false)

const summaryStats = computed(() => {
  const totalSchools = schools.value.length
  const totalPermits = permits.value.length
  
  // Breakdown by level (Permits can have multiple levels)
  const levels = {
    'Kindergarten': 0,
    'Elementary': 0,
    'Junior High School': 0,
    'Senior High School': 0
  }
  
  permits.value.forEach(p => {
    // Parse level string "Kindergarten, Elementary"
    const pLevels = (p.level || '').split(',').map(l => l.trim())
    pLevels.forEach(l => {
      if (levels[l] !== undefined) levels[l]++
    })
  })
  
  // Recent Permits (Last 5)
  const recentPermits = [...permits.value].sort((a, b) => {
    // Sort by ID assuming chronological or add date field later. 
    // For now, reverse order of array (newest last usually) or use ID timestamp if possible
    return b.id.localeCompare(a.id) 
  }).slice(0, 5).map(p => {
    const s = schools.value.find(sc => sc.id === p.school_id)
    return { ...p, schoolName: s ? s.name : 'Unknown' }
  })

  return { totalSchools, totalPermits, levels, recentPermits }
})

// ─── Data: schools (create first) and permits ───────────────────────────────
const schools = ref([])
const permits = ref([])
const previewPermit = ref(null)

onMounted(async () => {
  try {
    const [schoolsRes, permitsRes] = await Promise.all([
      fetch(`${API_URL}/schools`),
      fetch(`${API_URL}/permits`)
    ])
    if (schoolsRes.ok) schools.value = await schoolsRes.json()
    if (permitsRes.ok) permits.value = await permitsRes.json()
  } catch (error) {
    console.error('Failed to fetch data:', error)
  }
})

const searchQuery = ref('')
const rawSearchInput = ref('')
const isSearching = ref(false)
let searchTimeout = null

watch(rawSearchInput, (newVal) => {
  isSearching.value = true
  if (searchTimeout) clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    searchQuery.value = newVal
    isSearching.value = false
  }, 500)
})

// Level options for Upload Permit (multi-select like mockup)
const levelOptions = [
  { value: 'Kindergarten', label: 'Kindergarten' },
  { value: 'Elementary', label: 'Elementary' },
  { value: 'Junior High School', label: 'Junior High School' },
  { value: 'Senior High School', label: 'Senior High School' },
]

// ─── Create New School ──────────────────────────────────────────────────────
const schoolForm = ref({
  name: '',
  type: 'Private', // Default to Private
  address: '',
  fileName: '',
  file: null, // For OCR upload
  filePreviewUrl: null,
  ocrLoading: false,
  // Combined Flow Fields
  levels: [],
  schoolYear: '',
  permitNumber: '',
  strands: [],
  extractedText: '',
  detectedPermits: [] // Array of { permitNumber, schoolYear, levels, strands }
})
const schoolFormErrors = ref({})
const createTab = ref('school') // 'school' | 'homeschool'

async function onSchoolFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  
  if (schoolForm.value.filePreviewUrl) URL.revokeObjectURL(schoolForm.value.filePreviewUrl)
  schoolForm.value.file = file
  schoolForm.value.filePreviewUrl = URL.createObjectURL(file)
  schoolForm.value.fileName = file.name
  schoolForm.value.ocrLoading = true
  
  try {
    let text = ''
    if (file.type.startsWith('image/')) {
      const { data } = await Tesseract.recognize(file, 'eng')
      text = data.text
    } else if (file.type === 'application/pdf') {
       // Robust PDF text extract
       const buf = await file.arrayBuffer()
       const pdf = await getDocument({ data: buf }).promise
       
       const maxPages = Math.min(pdf.numPages, 10) // Increased to 10 to catch multiple permits
       for (let i = 1; i <= maxPages; i++) {
         const page = await pdf.getPage(i)
         const content = await page.getTextContent()
         let pageText = content.items.map((it) => ('str' in it ? it.str : '')).join(' ')
         
         // If text is too sparse, try OCR on the page (scanned PDF)
         if (pageText.replace(/\s/g, '').length < 50) {
            try {
              const viewport = page.getViewport({ scale: 2.0 })
              const canvas = document.createElement('canvas')
              const context = canvas.getContext('2d')
              canvas.height = viewport.height
              canvas.width = viewport.width
              await page.render({ canvasContext: context, viewport: viewport }).promise
              const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
              const { data } = await Tesseract.recognize(blob, 'eng')
              pageText = data.text
            } catch (ocrErr) {
              console.error('Page OCR failed:', ocrErr)
            }
         }
         text += pageText + ' '
       }
    }
    
    schoolForm.value.extractedText = text

    // Block signatures (Clean text)
    const signatureMarkers = [
      /Approved\s+by:/i,
      /Signed\s+by:/i,
      /Recommending\s+Approval:/i,
      /By\s+Authority\s+of\s+the\s+Secretary:/i,
      /Schools\s+Division\s+Superintendent/i,
      /Regional\s+Director/i,
      /Digitally\s+signed/i
    ]
    let cleanTextForName = text
    for (const marker of signatureMarkers) {
      const match = cleanTextForName.match(marker)
      if (match) {
         cleanTextForName = cleanTextForName.substring(0, match.index).trim()
         break 
      }
    }

    // Extract School Name & Address
    const lines = cleanTextForName.split('\n').map(l => l.trim()).filter(l => l)
    
    // Find School Name
    const schoolKeywords = ['School', 'Academy', 'College', 'Institute', 'University', 'Montessori', 'Learning Center']
    let foundName = ''
    
    // Strategy 1: Explicit labels
    for (let i = 0; i < lines.length - 1; i++) {
       const nextLine = lines[i+1].toLowerCase().replace(/\s/g, '')
       if (nextLine.includes('(school)') || nextLine.includes('(nameofschool)')) {
          foundName = lines[i]
          break
       }
    }

    if (!foundName) {
      const grantMatch = text.match(/(?:hereby\s+)?granted\s+to\s+([A-Z\s.,&'-]+?)(?:\s+to\s+operate|\s*located)/i)
      const theMatch = text.match(/The\s+([A-Z\s.,&'-]+?)\s+located\s+at/i)
      const explicitNameMatch = text.match(/(?:Name\s+of\s+School|School\s+Name)\s*[:.]?\s*([A-Z\s.,&'-]+)/i)

      if (grantMatch && grantMatch[1]) {
         foundName = grantMatch[1].trim()
      } else if (theMatch && theMatch[1]) {
         foundName = theMatch[1].trim()
      } else if (explicitNameMatch && explicitNameMatch[1]) {
         foundName = explicitNameMatch[1].trim()
      } else {
         const endorsementLine = lines.find(l => l.match(/Respectfully\s+endorsed\s+to/i))
         if (endorsementLine) {
            const match = endorsementLine.match(/(?:Administrator|Principal|Head|Director)\s+of\s+(?:the\s+)?(.*)/i)
            if (match && match[1]) {
               foundName = match[1].trim()
            } else {
               foundName = endorsementLine
            }
         } else {
             // Fallback: Only accept if it looks very much like a school name and isn't a header
             for (const line of lines) {
               if (line.match(/^(Respectfully|This\s+permit|Pursuant|Republic|Department|Region|Division|Office)/i)) continue
               // Must contain a keyword AND not be a sentence
               if (schoolKeywords.some(k => line.includes(k)) && line.length < 80 && !line.includes('...')) {
                  // Additional check: Should not start with "To:" or "From:"
                  if (/^(To|From|Subject|Attention):/i.test(line)) continue
                  
                  foundName = line
                  break
               }
             }
         }
      }
    }
    
    if (foundName) {
      const prefixMatch = foundName.match(/(?:Administrator|Principal|Head|Director)\s+of\s+(?:the\s+)?(.*)/i)
      if (prefixMatch && prefixMatch[1]) foundName = prefixMatch[1].trim()
      foundName = foundName.replace(/^Respectfully\s+endorsed\s+to\s+/i, '')
      foundName = foundName.replace(/[,.]+$/, '')
    }
    
    // Find Address (Refined for "City, Province" without unnecessary words)
    let foundAddress = ''
    
    // Strategy 1: Explicit labels
    for (let i = 0; i < lines.length - 1; i++) {
       const nextLine = lines[i+1].toLowerCase().replace(/\s/g, '')
       if (nextLine.includes('(completeaddress)') || nextLine.includes('(address)')) {
          foundAddress = lines[i]
          break
       }
    }

    if (!foundAddress) {
      // Look for line ending with "City" or "Province" or typical address format
      // Exclude headers starting with Department, Republic, Region, Division
      const addressBlockList = /^(Department|Republic|Region|Division|Office|District|Subject|To:|From:)/i
      
      // Strategy 2: Scan lines for City/Province
      for (const line of lines) {
        if (line.includes(foundName)) continue
        if (addressBlockList.test(line)) continue
        if (line.match(/^Respectfully\s+endorsed/i)) continue
        
        // Check for City/Province presence
        // Ensure it's not just "City Schools Division" or "Division of City"
        const hasCity = /\bCity\b/.test(line) && !/City\s+Schools\s+Division/i.test(line) && !/Division\s+of/i.test(line)
        const hasProvince = /\bProvince\b/.test(line) && !/Province\s+of/i.test(line) // Avoid "Province of Laguna" header alone if possible, though usually address includes it.
        const hasStreet = /\bSt\.\s/.test(line) || line.includes('Street') || line.includes('Subd') || line.includes('Brgy') || line.includes('Barangay')
        
        if (hasCity || hasProvince || hasStreet) {
           // Clean up unnecessary words if present
           let cleaned = line.replace(/^(located at|address[:.]?)\s*/i, '')
           
           // Truncate text that looks like the start of a sentence or legal clause
           // Matches "... City, Laguna, approving the herein..." -> "... City, Laguna"
           const stopWordsRegex = /[,.]?\s+(approving|approves|granting|granted|hereby|which|where|to\s+operate|is\s+located|subject\s+to|pursuant|under|following|endorsed|indorsed|recommending)\b/i
           const stopMatch = cleaned.match(stopWordsRegex)
           if (stopMatch) {
              cleaned = cleaned.substring(0, stopMatch.index).trim()
           }

           // Remove trailing punctuation
           cleaned = cleaned.replace(/[.,;:]+$/, '')

           // If it looks like a valid address (has numbers or multiple words)
           if (cleaned.split(' ').length > 2) {
              foundAddress = cleaned
              break
           }
        }
      }
    }
    
    if (foundName) schoolForm.value.name = foundName
    if (foundAddress) schoolForm.value.address = foundAddress

    // ─── Unified Flow: Extract Multiple Permits ───
    const extractedPermits = extractPermitDetails(text)
    if (extractedPermits.length > 0) {
      schoolForm.value.detectedPermits = extractedPermits
      
      // Auto-fill the first permit found to Streamline Registration
      const p = extractedPermits[0]
      schoolForm.value.permitNumber = p.permitNumber
      schoolForm.value.schoolYear = p.schoolYear
      schoolForm.value.levels = [...new Set([...schoolForm.value.levels, ...p.levels])] // Merge levels
      if (p.strands && p.strands.length > 0) {
         schoolForm.value.strands = [...new Set([...schoolForm.value.strands, ...p.strands])]
      }

      showToast(`Detected ${extractedPermits.length} permit(s). Auto-filled details.`, 'success')
    } else {
      schoolForm.value.detectedPermits = []
      showToast('School info scanned. No permits detected.', 'info')
    }

  } catch (err) {
    console.error(err)
    showToast('Failed to scan file', 'error')
  } finally {
    schoolForm.value.ocrLoading = false
  }
}

function setCreateTab(tab) {
  createTab.value = tab
  schoolFormErrors.value = {}
  
  const commonFields = {
    name: '',
    address: '',
    file: null,
    fileName: '',
    filePreviewUrl: null,
    ocrLoading: false,
    levels: [],
    schoolYear: '',
    permitNumber: '',
    strands: [],
    extractedText: '',
    detectedPermits: []
  }

  if (tab === 'homeschool') {
    schoolForm.value = { ...commonFields, type: 'Homeschooling' }
    setManageTab('application')
  } else {
    schoolForm.value = { ...commonFields, type: 'Private' }
    setManageTab('permit')
  }
}

// ─── Manage Records (Permits / Applications) ────────────────────────────────
const manageTab = ref('permit') // 'permit' | 'application'

const schoolOptions = computed(() => {
  return schools.value.filter(s => s.type !== 'Homeschooling')
})

const homeschoolOptions = computed(() => {
  return schools.value.filter(s => s.type === 'Homeschooling')
})

function setManageTab(tab) {
  manageTab.value = tab
  resetPermitForm()
}

function validateSchoolForm() {
  const err = {}
  if (!schoolForm.value.name?.trim()) err.name = 'School name is required'
  if (!schoolForm.value.type) err.type = 'School type is required'
  schoolFormErrors.value = err
  return Object.keys(err).length === 0
}

async function createSchool() {
  if (!validateSchoolForm()) return
  
  // Check for duplicate school name, allow exception if address is different (branch)
  const normalizedName = schoolForm.value.name.trim().toLowerCase()
  const sameNameSchools = schools.value.filter(s => s.name.trim().toLowerCase() === normalizedName)
  if (sameNameSchools.length > 0) {
    const newAddr = (schoolForm.value.address ?? '').trim().toLowerCase()
    const exactAddressMatch = sameNameSchools.find(s => (s.address ?? '').trim().toLowerCase() === newAddr)
    if (exactAddressMatch) {
      showToast(`School "${schoolForm.value.name}" at this address already exists`, 'error')
      return
    } else {
      const confirmed = await confirmAction(
        `A school named "${schoolForm.value.name}" already exists at a different address. Create as a separate branch?`
      )
      if (!confirmed) return
    }
  }

  const newSchool = {
    id: crypto.randomUUID?.() ?? Date.now().toString(36),
    name: schoolForm.value.name.trim(),
    type: schoolForm.value.type,
    address: (schoolForm.value.address ?? '').trim(),
  }

  try {
    const res = await fetch(`${API_URL}/schools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSchool)
    })
    
    if (res.ok) {
      const savedSchool = await res.json()
      schools.value.push(savedSchool)
      
      // ─── Unified Flow: Create Permit if details are present ───
      // Only if Permit Number and School Year are detected/entered
      if (schoolForm.value.permitNumber && schoolForm.value.schoolYear && schoolForm.value.levels.length > 0) {
         try {
           const formData = new FormData()
           formData.append('id', crypto.randomUUID?.() ?? Date.now().toString(36))
           formData.append('schoolId', savedSchool.id)
           formData.append('levels', JSON.stringify(schoolForm.value.levels))
           formData.append('schoolYear', schoolForm.value.schoolYear)
           formData.append('permitNumber', schoolForm.value.permitNumber)
           formData.append('extractedText', schoolForm.value.extractedText || '')
           
           if (schoolForm.value.levels.includes('Senior High School') && schoolForm.value.strands?.length) {
              formData.append('strands', JSON.stringify(schoolForm.value.strands))
           }
           
           if (schoolForm.value.file) {
              formData.append('file', schoolForm.value.file)
           }
           
           const permitRes = await fetch(`${API_URL}/permits`, {
              method: 'POST',
              body: formData
           })
           
           if (permitRes.ok) {
              const savedPermit = await permitRes.json()
              permits.value.push(savedPermit)
              showToast('School and Permit created successfully!', 'success')
           } else {
              showToast('School created, but failed to create permit', 'error')
           }
         } catch (pErr) {
            console.error('Permit creation failed', pErr)
            showToast('School created, but failed to create permit', 'error')
         }
      } else {
         showToast('School created successfully!', 'success')
      }

      // Reset form, keep current type based on tab
      schoolForm.value = { 
        name: '', 
        type: createTab.value === 'homeschool' ? 'Homeschooling' : 'Private', 
        address: '', 
        levels: [], 
        schoolYear: '', 
        permitNumber: '', 
        strands: [], 
        extractedText: '',
        file: null,
        fileName: '',
        filePreviewUrl: null,
        ocrLoading: false,
        detectedPermits: []
      }
      schoolFormErrors.value = {}
      
    } else {
      const errData = await res.json().catch(() => ({}))
      throw new Error(errData.error || 'Failed to create school')
    }
  } catch (error) {
    console.error(error)
    showToast(error.message || 'Error creating school', 'error')
  }
}

// ─── Upload Permit (with OCR for permit number) ──────────────────────────────
const permitForm = ref({
  schoolId: '',
  levels: [],
  schoolYear: '',
  file: null,
  filePreviewUrl: null,
  permitNumber: '',
  fileName: '',
})
const permitFormErrors = ref({})
const ocrLoading = ref(false)

// ─── Toast Notification ─────────────────────────────────────────────────────
const toast = ref({
  show: false,
  message: '',
  type: 'success' // 'success' | 'error'
})

let toastTimeout = null

function showToast(message, type = 'success') {
  toast.value = { show: true, message, type }
  
  if (toastTimeout) clearTimeout(toastTimeout)
  toastTimeout = setTimeout(() => {
    toast.value.show = false
  }, 3000)
}

/** Extract multiple permit details from OCR text */
function extractPermitDetails(text) {
  if (!text || !text.trim()) return []
  
  const t = text.replace(/\s+/g, ' ').trim()
  const permits = []

  // Helper: Detect Strands (Full names & Abbreviations)
  const detectStrands = (txt) => {
    const found = []
    // STEM
    if (/STEM|Science,? Technology,? Engineering,? (?:and|&) Mathematics/i.test(txt)) found.push('STEM')
    // ABM
    if (/ABM|Accountancy,? Business,? (?:and|&) Management/i.test(txt)) found.push('ABM')
    // HUMSS
    if (/HUMSS|Humanities (?:and|&) Social Sciences/i.test(txt)) found.push('HUMSS')
    // GAS
    if (/GAS|General Academic/i.test(txt)) found.push('GAS')
    // TVL
    if (/TVL|Technical[- ]Vocational[- ]Livelihood/i.test(txt)) found.push('TVL')
    // Sports
    if (/Sports/i.test(txt)) found.push('Sports')
    // Arts and Design
    if (/Arts (?:and|&) Design/i.test(txt)) found.push('Arts and Design')
    return found
  }
  
  // Strict Government Permit Pattern
  // Matches: "Government Permit (Region IV-A) No. K-123 s. 2024" or "GP No. 123 s. 2023"
  const gpRegex = /(?:Government\s+Permit|GP)(?:\s+\(Region\s+[IVX\d\w-]+\))?\s+No\.?\s*([A-Z0-9-]+)\s*s\.?\s*(\d{4})/gi
  
  let match
  while ((match = gpRegex.exec(t)) !== null) {
    const pNum = match[1].trim()
    const sYear = match[2].trim()
    
    // Infer Level from Permit Number Prefix
    const levels = []
    let strands = []
    
    if (/^K-/i.test(pNum)) levels.push('Kindergarten')
    else if (/^E-/i.test(pNum)) levels.push('Elementary')
    else if (/^JHS-/i.test(pNum) || /^S-/i.test(pNum)) levels.push('Junior High School')
    else if (/^SHS-/i.test(pNum)) {
      levels.push('Senior High School')
    }
    
    // If no prefix match, try to look at context around the match (e.g. 100 chars before)
    if (levels.length === 0) {
       const context = t.substring(Math.max(0, match.index - 200), match.index + 100)
       if (/Kindergarten/i.test(context)) levels.push('Kindergarten')
       if (/Elementary/i.test(context)) levels.push('Elementary')
       if (/Junior\s*High/i.test(context)) levels.push('Junior High School')
       if (/Senior\s*High/i.test(context)) levels.push('Senior High School')
    }

    // Detect Strands if SHS is involved
    if (levels.includes('Senior High School')) {
       strands = detectStrands(t)
    }

    permits.push({
      permitNumber: pNum,
      schoolYear: sYear,
      levels: levels,
      strands: strands
    })
  }

  // Fallback: If no strict "Government Permit" found, try looser extraction for single permit
  if (permits.length === 0) {
      // Use previous logic but stricter
      const loosePermits = []
      
      // Look for standalone permit numbers with prefixes
      const patterns = [
        { regex: /(SHS\s*-\s*\d+)/i, level: 'Senior High School' },
        { regex: /(JHS\s*-\s*\d+)/i, level: 'Junior High School' },
        { regex: /(K\s*-\s*\d+)/i, level: 'Kindergarten' },
        { regex: /(E\s*-\s*\d+)/i, level: 'Elementary' }
      ]
      
      // Look for School Year
      const syMatch = t.match(/s\.?\s*(\d{4})/i) || t.match(/(\d{4})\s*[-–]\s*(\d{4})/i)
      const foundYear = syMatch ? (syMatch[2] ? `${syMatch[1]}-${syMatch[2]}` : syMatch[1]) : ''
      
      for (const p of patterns) {
         const m = t.match(p.regex)
         if (m) {
            let strands = []
            if (p.level === 'Senior High School') {
               strands = detectStrands(t)
            }

            loosePermits.push({
               permitNumber: m[1].replace(/\s/g, ''),
               schoolYear: foundYear,
               levels: [p.level],
               strands: strands
            })
         }
      }
      
      // Deduplicate by permitNumber
      const unique = []
      const seen = new Set()
      for (const p of loosePermits) {
        if (!seen.has(p.permitNumber)) {
          seen.add(p.permitNumber)
          unique.push(p)
        }
      }
      return unique
  }
  
  return permits
}

async function onPermitFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  if (permitForm.value.filePreviewUrl) URL.revokeObjectURL(permitForm.value.filePreviewUrl)
  permitForm.value.file = file
  permitForm.value.filePreviewUrl = URL.createObjectURL(file)
  permitForm.value.fileName = file.name
  permitFormErrors.value.upload = null
  permitForm.value.permitNumber = ''
  permitForm.value.extractedText = ''
  
  ocrLoading.value = true
  try {
    let extractedPermits = []
    let fullText = ''
    
    if (file.type.startsWith('image/')) {
      const { data } = await Tesseract.recognize(file, 'eng')
      fullText = data.text
      extractedPermits = extractPermitDetails(fullText)
    } else if (file.type === 'application/pdf') {
      const buf = await file.arrayBuffer()
      const pdf = await getDocument({ data: buf }).promise
      
      const maxPages = Math.min(pdf.numPages, 50)
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i)
        const content = await page.getTextContent()
        let pageText = content.items.map((it) => ('str' in it ? it.str : '')).join(' ')
        
        if (pageText.replace(/\s/g, '').length < 50) {
           try {
             const viewport = page.getViewport({ scale: 2.0 })
             const canvas = document.createElement('canvas')
             const context = canvas.getContext('2d')
             canvas.height = viewport.height
             canvas.width = viewport.width
             await page.render({ canvasContext: context, viewport: viewport }).promise
             const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
             const { data } = await Tesseract.recognize(blob, 'eng')
             pageText = data.text
           } catch (ocrErr) {
             console.error('Page OCR failed:', ocrErr)
           }
        }
        fullText += pageText + ' '
      }
      extractedPermits = extractPermitDetails(fullText)
    }

    permitForm.value.extractedText = fullText

    // Handle the first detected permit for the Permit Upload form
    // (User can manually adjust if multiple are found, but this form is usually for one)
    if (extractedPermits.length > 0) {
       const p = extractedPermits[0]
       permitForm.value.permitNumber = p.permitNumber
       permitForm.value.schoolYear = p.schoolYear
       permitForm.value.levels = p.levels
       permitForm.value.strands = p.strands
       
       if (extractedPermits.length > 1) {
          showToast(`Detected ${extractedPermits.length} permits. Using the first one (${p.permitNumber}).`, 'info')
       } else {
          showToast('Permit details scanned successfully', 'success')
       }
    } else {
       showToast('No specific Government Permit details found', 'info')
    }
    
    // Check school name match
    if (permitForm.value.schoolId) {
      const schoolName = getSchoolName(permitForm.value.schoolId)
      const match = checkSchoolNameMatch(fullText, schoolName)
      if (match) {
        showToast(`Verified: Document matches "${schoolName}"`, 'success')
      } else {
        showToast(`Warning: School name "${schoolName}" not found in document`, 'error')
      }
    }
    
  } catch (_) {
    console.error(_)
  } finally {
    ocrLoading.value = false
  }
}

const isHomeschooling = computed(() => {
  if (!permitForm.value.schoolId) return false
  return getSchoolType(permitForm.value.schoolId) === 'Homeschooling'
})

function validatePermitForm() {
  const err = {}
  if (!permitForm.value.schoolId) err.schoolId = 'Please select a school'
  if (!permitForm.value.levels?.length) err.levels = 'Select at least one level'
  if (!permitForm.value.schoolYear) {
    err.schoolYear = 'School year is required'
  } else if (!/^\d{4}-\d{4}$/.test(permitForm.value.schoolYear)) {
    err.schoolYear = 'Format must be YYYY-YYYY (e.g., 2024-2025)'
  }

  // Validate Permit Number (Must look like a Government Permit, e.g., SHS-123, E-001)
  const pNum = permitForm.value.permitNumber?.trim()
  if (!pNum) {
    // Optional? No, user implies it's required for validity.
    // If it's a "Government Permit", it must have a number.
    // But existing code didn't enforce it. Let's enforce it now based on "that's only valid permit".
    err.permitNumber = 'Permit number is required'
  } else {
    // Check format: At least one letter, followed by hyphen (optional) and numbers
    // e.g. "SHS-001", "E-123", "001" (maybe just numbers?)
    // Let's require at least alphanumeric.
    if (!/^[A-Z0-9-]+$/i.test(pNum) || !/\d/.test(pNum)) {
      err.permitNumber = 'Invalid format. Format: e.g., SHS-062, E-123'
    }
  }
  
  // File upload is required only for non-homeschooling
  if (!isHomeschooling.value && !permitForm.value.file) {
    err.upload = 'Please upload a permit copy'
  }
  
  permitFormErrors.value = err
  return Object.keys(err).length === 0
}

function resetPermitForm() {
  permitForm.value = {
    schoolId: '',
    levels: [],
    schoolYear: '',
    file: null,
    filePreviewUrl: null,
    permitNumber: '',
    fileName: '',
    extractedText: '', // Store full OCR text for validation
    strands: [],
  }
  permitFormErrors.value = {}
}

function checkSchoolNameMatch(text, schoolName) {
  if (!text || !schoolName) return false
  
  // Normalize strings: lowercase, remove non-alphanumeric, remove common suffixes
  const clean = (s) => {
    let str = s.toLowerCase()
    // Remove common suffixes to focus on the core name
    str = str.replace(/,\s*inc\.?$/g, '')
             .replace(/\s+inc\.?$/g, '')
             .replace(/,\s*incorporated$/g, '')
             .replace(/\s+incorporated$/g, '')
             .replace(/,\s*corporation$/g, '')
             .replace(/\s+city$/g, '')
             .replace(/\s+laguna$/g, '') // Remove location if user didn't type it
    return str.replace(/[^a-z0-9]/g, '')
  }

  const t = clean(text)
  const n = clean(schoolName)
  
  // Simple check: is the school name inside the text?
  if (t.includes(n)) return true
  
  // Fallback: Check if > 50% of words match
  const normalizeWords = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/) 
  const tWords = new Set(normalizeWords(text))
  const nWords = normalizeWords(schoolName).filter(w => w.length > 2 && !['inc', 'incorporated', 'city', 'laguna'].includes(w))
  
  if (nWords.length === 0) return false
  
  const matches = nWords.filter(w => tWords.has(w))
  return matches.length / nWords.length >= 0.5 // Lowered to 50% match
}

const showConfirmation = ref(false)
const confirmationMessage = ref('')
const confirmationResolve = ref(null)

function confirmAction(message) {
  confirmationMessage.value = message
  showConfirmation.value = true
  return new Promise((resolve) => {
    confirmationResolve.value = resolve
  })
}

function handleConfirmation(result) {
  showConfirmation.value = false
  if (confirmationResolve.value) {
    confirmationResolve.value(result)
    confirmationResolve.value = null
  }
}

async function submitPermit() {
  if (!validatePermitForm()) return
  
  const formData = new FormData()
  const id = crypto.randomUUID?.() ?? Date.now().toString(36)
  
  formData.append('id', id)
  formData.append('schoolId', permitForm.value.schoolId)
  formData.append('levels', JSON.stringify(permitForm.value.levels))
  formData.append('schoolYear', permitForm.value.schoolYear)
  formData.append('permitNumber', (permitForm.value.permitNumber ?? '').trim())
  formData.append('extractedText', permitForm.value.extractedText || '')

  // Add strands if SHS is selected
  if (permitForm.value.levels.includes('Senior High School') && permitForm.value.strands?.length) {
    formData.append('strands', JSON.stringify(permitForm.value.strands))
  }
  
  if (permitForm.value.file) {
    formData.append('file', permitForm.value.file)
  }

  // Final check: Validate school name match if we have OCR text
  // We don't have the full OCR text here easily unless we stored it. 
  // But we have onPermitFileChange running it. 
  // Let's assume validation is "soft" or handled during upload via toast.
  // Actually user said "make sure", so let's enforce if we can.
  // But we didn't store the full text. 
  // Let's add fullText to permitForm to allow validation on submit.
  if (permitForm.value.extractedText && permitForm.value.schoolId) {
    const schoolName = getSchoolName(permitForm.value.schoolId)
    const match = checkSchoolNameMatch(permitForm.value.extractedText, schoolName)
    if (!match) {
      const confirmed = await confirmAction(`Warning: The school name "${schoolName}" was not found in the uploaded document. Continue anyway?`)
      if (!confirmed) return
    }
  }

  try {
    const res = await fetch(`${API_URL}/permits`, {
      method: 'POST',
      body: formData
    })
    
    if (res.ok) {
      const savedPermit = await res.json()
      permits.value.push(savedPermit)
      resetPermitForm()
      showToast('Permit uploaded successfully!', 'success')
    } else {
      const errData = await res.json().catch(() => ({}))
      throw new Error(errData.error || 'Failed to upload permit')
    }
  } catch (error) {
    console.error(error)
    showToast(error.message || 'Error uploading permit', 'error')
  }
}

// Toggle level in multi-select
function toggleLevel(value) {
  const i = permitForm.value.levels.indexOf(value)
  if (i >= 0) permitForm.value.levels.splice(i, 1)
  else permitForm.value.levels.push(value)
}

function toggleSchoolLevel(value) {
  const i = schoolForm.value.levels.indexOf(value)
  if (i >= 0) schoolForm.value.levels.splice(i, 1)
  else schoolForm.value.levels.push(value)
}

// ─── Status logic ───────────────────────────────────────────────────────────
function getStatus(schoolYear) {
  if (!schoolYear) return { label: 'Unknown', color: 'gray' }
  
  // Parse YYYY-YYYY
  const parts = schoolYear.split('-').map(p => parseInt(p.trim(), 10))
  if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
    return { label: 'Invalid SY', color: 'gray' }
  }
  
  // Assumption: School Year 2024-2025 expires effectively around mid-2025.
  // Let's set expiration date to July 31 of the end year.
  // End Year = parts[1]
  const endYear = parts[1]
  const expirationDate = new Date(endYear, 6, 31) // Month 6 is July
  
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  expirationDate.setHours(0, 0, 0, 0)
  
  const daysLeft = Math.floor((expirationDate - now) / (24 * 60 * 60 * 1000))
  
  if (daysLeft < 0) return { label: 'Closed', color: 'red' }
  if (daysLeft <= 60) return { label: 'For Renewal', color: 'yellow' }
  return { label: 'Operational', color: 'green' }
}

function getSchoolName(schoolId) {
  return schools.value.find((s) => s.id === schoolId)?.name ?? 'Unknown'
}

function getSchoolType(schoolId) {
  return schools.value.find((s) => s.id === schoolId)?.type ?? 'Public'
}

function openPreview(p) {
  previewPermit.value = p
}

function closePreview() {
  previewPermit.value = null
}

// ─── Public Search: filtered results ────────────────────────────────────────
const filterType = ref('All') // 'All' | 'Public' | 'Private'

const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const type = filterType.value
  
  // Group permits by schoolId
  const grouped = {}
  permits.value.forEach(p => {
    if (!grouped[p.schoolId]) {
      grouped[p.schoolId] = {
        schoolId: p.schoolId,
        schoolName: getSchoolName(p.schoolId),
        schoolType: getSchoolType(p.schoolId),
        permits: []
      }
    }
    grouped[p.schoolId].permits.push(p)
  })
  
  let results = Object.values(grouped)
  
  // Filter by query (school name)
  if (q) {
    results = results.filter((g) => g.schoolName.toLowerCase().includes(q))
  }
  
  // Filter by type
  if (type !== 'All') {
    results = results.filter((g) => g.schoolType === type)
  }
  
  return results
})

const showEmptyState = computed(() => {
  const q = searchQuery.value.trim()
  // If no query and filtering 'All', maybe show all? 
  // Original logic: "return !q || searchResults.value.length === 0"
  // Let's change to: show empty state if no query, regardless of filter, 
  // OR if there are no results found for the query/filter combo.
  // Actually, usually search page is empty until you search.
  // But if I want to "sort whether private or public", maybe listing them is better?
  // Let's stick to "search first" but respect the filter.
  return !q || searchResults.value.length === 0
})
</script>

<template>
  <div class="min-h-screen bg-[#F8FAFC] text-slate-800">
    <!-- Toast Notification -->
    <Transition
      enter-active-class="transition ease-out duration-300"
      enter-from-class="translate-y-2 opacity-0 sm:translate-y-0 sm:translate-x-2"
      enter-to-class="translate-y-0 opacity-100 sm:translate-x-0"
      leave-active-class="transition ease-in duration-200"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="toast.show"
        class="fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border"
        :class="toast.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'"
      >
        <CheckCircle v-if="toast.type === 'success'" :size="20" />
        <XCircle v-else :size="20" />
        <span class="font-medium text-sm">{{ toast.message }}</span>
      </div>
    </Transition>

    <!-- Header: shield + title + nav (matches mockup) ───────────────────────── -->
    <header class="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-10">
      <div class="max-w-7xl mx-auto px-4 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 sm:gap-0">
        <div class="flex items-center gap-2">
          <div class="p-1.5 rounded-lg bg-slate-100 text-sky-600">
            <Shield :size="22" stroke-width="2" />
          </div>
          <h1 class="text-lg font-semibold text-slate-800">DepEd Cabuyao • School Permit Registry</h1>
        </div>
        <nav class="flex items-center gap-4 sm:gap-6 w-full sm:w-auto justify-center sm:justify-end">
          <button
            type="button"
            @click="currentView = 'search'"
            class="inline-flex items-center gap-2 text-sm font-medium transition-colors"
            :class="currentView === 'search' ? 'text-sky-600' : 'text-slate-500 hover:text-slate-700'"
          >
            <Home :size="18" />
            Public Search
          </button>
          <button
            type="button"
            @click="currentView = 'admin'"
            class="inline-flex items-center gap-2 text-sm font-medium transition-colors"
            :class="currentView === 'admin' ? 'text-sky-600' : 'text-slate-500 hover:text-slate-700'"
          >
            <Building2 :size="18" />
            Admin Dashboard
          </button>
        </nav>
      </div>
    </header>

    <!-- ─── Public Search view ─────────────────────────────────────────────── -->
    <main v-if="currentView === 'search'" class="max-w-5xl mx-auto px-4 py-8">
      <h2 class="text-2xl font-bold text-slate-800 text-center mb-1">Search School Permits</h2>
      <p class="text-slate-600 text-center mb-8">
        Enter a school name to view permit status by education level
      </p>

      <div class="flex flex-col sm:flex-row gap-4 mb-8">
        <div class="relative flex-1">
          <Search
            class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
            :size="20"
          />
          <input
            v-model="rawSearchInput"
            type="text"
            placeholder="Search for a school..."
            class="w-full pl-12 pr-4 py-3 rounded-lg border border-slate-300 bg-white focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none text-slate-800 placeholder-slate-400"
          />
        </div>
        <CustomSelect
          v-model="filterType"
          :options="[
            { value: 'All', label: 'All Types' },
            { value: 'Public', label: 'Public' },
            { value: 'Private', label: 'Private' },
            { value: 'Homeschooling', label: 'Homeschooling' }
          ]"
          class="w-48"
        />
      </div>

      <!-- Loading State -->
      <div v-if="isSearching" class="py-12 text-center">
        <Loader2 class="animate-spin mx-auto text-sky-600 mb-4" :size="40" />
        <p class="text-slate-600 font-medium">Searching...</p>
      </div>

      <!-- Empty state card (mockup style) -->
      <div
        v-else-if="showEmptyState"
        class="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center"
      >
        <div class="inline-flex items-center justify-center w-20 h-20 rounded-full bg-sky-50 text-sky-500 mb-4">
          <Search :size="40" stroke-width="1.5" />
        </div>
        <p class="text-slate-800 font-medium mb-1">Enter a school name above to search</p>
        <p class="text-sm text-slate-500">Start typing to find school permit information</p>
      </div>

      <!-- Result cards -->
      <ul v-else class="space-y-4">
        <li
          v-for="group in searchResults"
          :key="group.schoolId"
          class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden"
        >
          <div class="p-5">
            <div class="flex justify-between items-start mb-4">
              <h3 class="font-semibold text-slate-800 text-lg">{{ group.schoolName }}</h3>
              <span 
                class="px-2 py-0.5 rounded text-xs font-medium border"
                :class="{
                  'bg-purple-50 text-purple-700 border-purple-200': group.schoolType === 'Private',
                  'bg-blue-50 text-blue-700 border-blue-200': group.schoolType === 'Public',
                  'bg-orange-50 text-orange-700 border-orange-200': group.schoolType === 'Homeschooling'
                }"
              >
                {{ group.schoolType }}
              </span>
            </div>

            <!-- List of permits for this school -->
            <div class="space-y-4">
              <div 
                v-for="(p) in group.permits" 
                :key="p.id" 
                class="pt-4 first:pt-0 border-t border-slate-100 first:border-0"
              >
                <div class="flex flex-wrap gap-2 mb-2">
                  <span
                    v-for="level in p.levels"
                    :key="level"
                    :class="{
                      'bg-emerald-100 text-emerald-800': getStatus(p.schoolYear).color === 'green',
                      'bg-amber-100 text-amber-800': getStatus(p.schoolYear).color === 'yellow',
                      'bg-red-100 text-red-800': getStatus(p.schoolYear).color === 'red',
                      'bg-gray-100 text-gray-800': getStatus(p.schoolYear).color === 'gray',
                    }"
                    class="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium"
                  >
                    {{ level }}: {{ getStatus(p.schoolYear).label }}
                  </span>
                </div>
                
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-0">
                  <div class="text-sm text-slate-600">
                    <span v-if="p.permitNumber">Permit No. {{ p.permitNumber }}</span>
                    <span v-if="p.permitNumber" class="hidden sm:inline text-slate-300 mx-2">|</span>
                    <span :class="{'block text-xs text-slate-400 mt-1 sm:inline sm:text-sm sm:text-slate-600 sm:mt-0': p.permitNumber}">
                      SY {{ p.schoolYear }}
                    </span>
                  </div>
                  
                  <button
                    v-if="p.filePreviewUrl"
                    type="button"
                    @click="openPreview(p)"
                    class="inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium text-sky-700 bg-sky-50 rounded-lg hover:bg-sky-100 transition-colors w-full sm:w-auto"
                  >
                    <FileImage :size="16" />
                    View File
                  </button>
                  <span v-else class="text-sm text-slate-400 italic">No file attached</span>
                </div>
              </div>
            </div>
          </div>
        </li>
      </ul>
    </main>

    <!-- ─── Admin Dashboard view ───────────────────────────────────────────── -->
    <main v-else class="max-w-4xl mx-auto px-4 py-8">
      <h2 class="text-2xl font-bold text-slate-800 mb-1">Admin Dashboard</h2>
      <p class="text-slate-600 mb-8">Manage schools and upload permit documents.</p>

      <!-- Summary Dashboard (Toggleable) -->
      <div class="mb-8">
        <div class="flex items-center justify-between mb-4">
           <h3 class="text-lg font-bold text-slate-800 flex items-center gap-2">
             <LayoutDashboard class="w-5 h-5 text-sky-600" />
             System Overview
           </h3>
           <button 
             @click="showSummary = !showSummary"
             class="text-sm text-sky-600 hover:text-sky-700 font-medium"
           >
             {{ showSummary ? 'Hide Summary' : 'Show Summary' }}
           </button>
        </div>
        
        <div v-if="showSummary" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 animate-in fade-in slide-in-from-top-4 duration-300">
           <!-- Total Schools -->
           <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
              <div class="p-3 bg-blue-50 text-blue-600 rounded-lg">
                <Building2 class="w-6 h-6" />
              </div>
              <div>
                <p class="text-sm text-slate-500 font-medium">Registered Schools</p>
                <p class="text-2xl font-bold text-slate-800">{{ summaryStats.totalSchools }}</p>
              </div>
           </div>
           
           <!-- Total Permits -->
           <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
              <div class="p-3 bg-emerald-50 text-emerald-600 rounded-lg">
                <CheckCircle class="w-6 h-6" />
              </div>
              <div>
                <p class="text-sm text-slate-500 font-medium">Active Permits</p>
                <p class="text-2xl font-bold text-slate-800">{{ summaryStats.totalPermits }}</p>
              </div>
           </div>
           
           <!-- Level Breakdown (Mini Chart Representation) -->
           <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm md:col-span-2">
              <div class="flex items-center gap-2 mb-3">
                 <BarChart3 class="w-5 h-5 text-slate-400" />
                 <p class="text-sm text-slate-500 font-medium">Permits by Level</p>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
                 <div v-for="(count, level) in summaryStats.levels" :key="level" class="text-center p-2 bg-slate-50 rounded-lg">
                    <span class="block text-xs text-slate-500 truncate mb-1" :title="level">{{ level.replace('School', '') }}</span>
                    <span class="block text-lg font-bold text-slate-800">{{ count }}</span>
                 </div>
              </div>
           </div>
        </div>
      </div>

      <!-- Create New School card -->
      <section class="bg-white rounded-xl border border-slate-200 shadow-sm p-6 mb-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div class="flex items-center gap-2">
            <div class="p-1.5 rounded-lg bg-sky-100 text-sky-600">
              <Plus :size="20" />
            </div>
            <h3 class="text-lg font-semibold text-slate-800">Registration</h3>
          </div>
          
          <!-- Tabs -->
          <div class="flex bg-slate-100 p-1 rounded-lg self-start sm:self-auto">
            <button
              type="button"
              @click="setCreateTab('school')"
              class="px-4 py-1.5 text-sm font-medium rounded-md transition-all"
              :class="createTab === 'school' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
            >
              School
            </button>
            <button
              type="button"
              @click="setCreateTab('homeschool')"
              class="px-4 py-1.5 text-sm font-medium rounded-md transition-all"
              :class="createTab === 'homeschool' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
            >
              Homeschooling
            </button>
          </div>
        </div>

        <form @submit.prevent="createSchool" class="space-y-4">
          
          <!-- Upload Scan for Details (Common) -->
          <div class="mb-4 p-4 bg-slate-50 rounded-lg border border-dashed border-slate-300">
            <label class="block text-sm font-medium text-slate-700 mb-2">
               Auto-fill details from Document (Optional)
            </label>
            <div class="flex items-center gap-4">
               <input 
                 type="file" 
                 accept=".pdf,image/*" 
                 @change="onSchoolFileChange"
                 class="block w-full text-sm text-slate-500
                    file:mr-4 file:py-2 file:px-4
                    file:rounded-full file:border-0
                    file:text-sm file:font-semibold
                    file:bg-sky-50 file:text-sky-700
                    hover:file:bg-sky-100"
               />
               <div v-if="schoolForm.ocrLoading" class="flex items-center text-sky-600 text-sm">
                 <Loader2 class="w-4 h-4 mr-2 animate-spin" />
                 Scanning...
               </div>
            </div>
            <p class="text-xs text-slate-500 mt-2">Upload a permit or registration document to auto-detect details.</p>
          </div>

          <!-- Name Field (Dynamic Label) -->
          <div>
            <label for="schoolName" class="block text-sm font-medium text-slate-700 mb-1">
              {{ createTab === 'school' ? 'School Name' : 'Homeschooling Provider Name' }} <span class="text-red-500">*</span>
            </label>
            <input
              id="schoolName"
              v-model="schoolForm.name"
              type="text"
              :placeholder="createTab === 'school' ? 'e.g., St. Mary\'s Academy' : 'e.g., Happy Homeschool Center'"
              class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none"
              :class="{ 'border-red-500': schoolFormErrors.name }"
            />
            <p v-if="schoolFormErrors.name" class="mt-1 text-sm text-red-600">{{ schoolFormErrors.name }}</p>
          </div>

          <!-- Common Address Field -->
          <div>
            <label for="schoolAddress" class="block text-sm font-medium text-slate-700 mb-1">Address</label>
            <input
              id="schoolAddress"
              v-model="schoolForm.address"
              type="text"
              placeholder="e.g., 123 Main Street, City, Province"
              class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none"
            />
          </div>

          <!-- Unified Permit Details Section -->
          <div class="mt-6 pt-6 border-t border-slate-200 animate-in fade-in slide-in-from-top-4 duration-500">
             <div class="flex items-center gap-2 mb-4">
                <div class="p-1 rounded bg-emerald-100 text-emerald-600">
                   <Shield :size="16" />
                </div>
                <h3 class="text-sm font-semibold text-slate-800">
                  {{ createTab === 'school' ? 'Permit Details' : 'Application Data' }}
                </h3>
             </div>

             <!-- Levels -->
             <div class="mb-4">
                <label class="block text-sm font-medium text-slate-700 mb-2">Program / Level</label>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label 
                    v-for="opt in levelOptions" 
                    :key="opt.value" 
                    class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-200"
                    :class="schoolForm.levels.includes(opt.value) ? 'border-sky-500 bg-sky-50' : 'border-slate-200 hover:border-slate-300'"
                  >
                    <div 
                      class="w-5 h-5 rounded border flex items-center justify-center transition-colors"
                      :class="schoolForm.levels.includes(opt.value) ? 'bg-sky-500 border-sky-500' : 'border-slate-300 bg-white'"
                    >
                      <CheckCircle v-if="schoolForm.levels.includes(opt.value)" class="w-3.5 h-3.5 text-white" />
                    </div>
                    <input 
                      type="checkbox" 
                      :value="opt.value" 
                      class="hidden"
                      @change="toggleSchoolLevel(opt.value)"
                      :checked="schoolForm.levels.includes(opt.value)"
                    >
                    <span class="text-sm font-medium" :class="schoolForm.levels.includes(opt.value) ? 'text-sky-900' : 'text-slate-700'">
                      {{ opt.label }}
                    </span>
                  </label>
                </div>
             </div>

             <!-- Permit No & SY -->
             <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div v-if="createTab === 'school'">
                   <label class="block text-sm font-medium text-slate-700 mb-1">Permit Number</label>
                   <div class="relative overflow-hidden rounded-lg">
                      <input 
                        v-model="schoolForm.permitNumber"
                        type="text"
                        class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none pr-10"
                        :class="[
                           schoolForm.permitNumber ? 'bg-emerald-50 border-emerald-200' : '',
                           schoolForm.ocrLoading ? 'border-sky-400 ring-2 ring-sky-100' : ''
                        ]"
                      />
                      
                      <!-- Scanning Effect Overlay (Shimmer) -->
                      <div v-if="schoolForm.ocrLoading" class="absolute inset-0 pointer-events-none rounded-lg overflow-hidden">
                         <div class="absolute top-0 left-0 w-full h-full bg-gradient-to-r from-transparent via-sky-400/10 to-transparent -translate-x-full animate-shimmer"></div>
                      </div>

                      <!-- Animated Loading Icon (Document Scan) -->
                      <div v-if="schoolForm.ocrLoading" class="absolute right-3 top-1/2 -translate-y-1/2">
                        <div class="relative w-5 h-5">
                           <svg class="w-full h-full text-sky-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                           </svg>
                           <!-- Scanning Beam Line -->
                           <div class="absolute top-0 left-0 w-full h-[2px] bg-sky-600 shadow-[0_0_8px_rgba(2,132,199,0.8)] animate-scan-vertical"></div>
                        </div>
                      </div>

                      <div v-else-if="schoolForm.permitNumber" class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 flex items-center gap-1 text-xs font-medium">
                         <CheckCircle :size="14" />
                         Match
                      </div>
                   </div>
                </div>
                <div>
                   <label class="block text-sm font-medium text-slate-700 mb-1">School Year</label>
                   <div class="relative">
                      <input 
                        v-model="schoolForm.schoolYear"
                        type="text"
                        class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none"
                        :class="schoolForm.schoolYear ? 'bg-emerald-50 border-emerald-200' : ''"
                      />
                      <div v-if="schoolForm.schoolYear" class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 flex items-center gap-1 text-xs font-medium">
                         <CheckCircle :size="14" />
                         Match
                      </div>
                   </div>
                </div>
             </div>
             
             <!-- Strands -->
             <div v-if="schoolForm.levels.includes('Senior High School')" class="mt-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
                <label class="block text-sm font-medium text-slate-800 mb-2">SHS Strands</label>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label 
                    v-for="strand in ['STEM', 'ABM', 'HUMSS', 'GAS', 'TVL', 'Arts and Design', 'Sports']" 
                    :key="strand" 
                    class="flex items-center gap-2 cursor-pointer"
                  >
                    <input 
                      type="checkbox" 
                      :value="strand" 
                      v-model="schoolForm.strands"
                      class="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                    >
                    <span class="text-sm text-slate-700">{{ strand }}</span>
                  </label>
                </div>
             </div>
          </div>

          <button
            type="submit"
            class="w-full py-2.5 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 transition-colors"
          >
            {{ createTab === 'school' ? 'Create School' : 'Create Provider' }}
          </button>
        </form>
      </section>

    </main>

    <div
      v-if="previewPermit"
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4"
    >
      <div class="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h3 class="text-sm font-semibold text-slate-800">
            Permit File
          </h3>
          <button
            type="button"
            class="text-slate-500 hover:text-slate-700 text-sm"
            @click="closePreview"
          >
            Close
          </button>
        </div>
        <div class="flex-1 overflow-hidden">
          <div v-if="previewPermit.fileName?.toLowerCase().endsWith('.pdf')" class="w-full h-[70vh]">
            <iframe
              :src="previewPermit.filePreviewUrl"
              class="w-full h-full border-0"
            />
          </div>
          <div v-else class="w-full h-[70vh] flex items-center justify-center bg-slate-50">
            <img
              :src="previewPermit.filePreviewUrl"
              alt="Permit preview"
              class="max-h-full max-w-full object-contain"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Confirmation Modal -->
    <Transition
      enter-active-class="transition ease-out duration-200"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition ease-in duration-150"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="showConfirmation"
        class="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      >
        <div class="bg-white rounded-xl shadow-2xl max-w-md w-full p-4 sm:p-6 border border-slate-100">
          <div class="flex items-center gap-3 text-amber-600 mb-4">
            <div class="p-2 bg-amber-50 rounded-full">
              <Shield :size="24" class="text-amber-500" />
            </div>
            <h3 class="text-lg font-semibold text-slate-800">Verification Warning</h3>
          </div>
          
          <p class="text-slate-600 mb-6 leading-relaxed">
            {{ confirmationMessage }}
          </p>
          
          <div class="flex justify-end gap-3">
            <button
              @click="handleConfirmation(false)"
              class="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-medium hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              @click="handleConfirmation(true)"
              class="px-4 py-2 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 transition-colors shadow-sm"
            >
              Continue Anyway
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* Custom Animations for Unique Loading Experience */

/* Shimmer Effect for Input Background */
@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

/* Vertical Scan Beam for Document Icon */
@keyframes scan-vertical {
  0% { top: 15%; opacity: 0; }
  15% { opacity: 1; }
  85% { opacity: 1; }
  100% { top: 85%; opacity: 0; }
}

.animate-shimmer {
  animation: shimmer 1.5s infinite linear;
}

.animate-scan-vertical {
  animation: scan-vertical 1.5s infinite linear;
}
</style>
