
// Helper to clean common OCR errors
export function cleanOCRText(text) {
  if (!text) return ''
  return text
    .replace(/\|/g, 'I') // Pipe to I
    .replace(/\[/g, 'L') // Bracket to L
    .replace(/\]/g, 'J') // Bracket to J
    .replace(/\{/g, '(') // Curly to Paren
    .replace(/\}/g, ')') // Curly to Paren
    .replace(/([0-9])s(?=\s)/gi, '$1') // 2020s -> 2020
    .replace(/([a-z])0/gi, '$1o') // a0 -> ao
    .replace(/0([a-z])/gi, 'o$1') // 0a -> oa
    .replace(/GOVERN\s*MENT/gi, 'GOVERNMENT') // Fix split word
    .replace(/DEPART\s*MENT/gi, 'DEPARTMENT') // Fix split word
    .replace(/l{3}/g, 'III') // lll -> III (risky but common in R-III)
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '')
}

export function extractSchoolInfoFromText(text) {
  if (!text) return { schoolName: '', address: '' }

  const cleanText = cleanOCRText(text)
  // console.log('Clean Text:', cleanText)
  let name = ''
  let address = ''

  // 1. Name Strategy: Explicit "To: <Name>" (common in permits)
  // Look for "To:" followed by capitalized text, stopping at "School" or newlines
  // Fixed: Handle "Granted to" not at start of line, but restrict "To" to start of line to avoid "Pursuant to"
  const toMatch = cleanText.match(/(?:(?:^|\n)\s*To|(?:^|\n).*?(?:Granted\s+to|Issued\s+to))[:\s]*\n*([A-Z0-9\s.,&'()-]+?)(?:\n+\(School\)|\s+located\s+at|\s+to\s+operate|\s+for\s+the|\n|$)/i)
  if (toMatch && toMatch[1]) {
    const candidate = toMatch[1].trim()
    if (!candidate.includes('Regional Director') && candidate.length > 3) {
      name = candidate
      // console.log('Strategy 1 matched:', name)
    }
  }

  // 2. Name Strategy: "The <Name> located/situated at"
  if (!name) {
    const theMatch = cleanText.match(/(?:^|\n)\s*The\s+([A-Z0-9\s.,&'()-]+?)\s+(?:located|situated)\s+(?:at|in)/i)
    if (theMatch && theMatch[1]) {
      name = theMatch[1].trim()
      // console.log('Strategy 2 matched:', name)
    }
  }

  // 3. Name Strategy: Explicit Labels "(School)"
  if (!name) {
    const lines = cleanText.split('\n').map(l => l.trim())
    for (let i = 0; i < lines.length; i++) {
      if (/\(School\)/i.test(lines[i]) || /\(Name of School\)/i.test(lines[i])) {
        if (i > 0 && lines[i-1].length > 3 && !/^To$/i.test(lines[i-1])) {
          name = lines[i-1]
          // console.log('Strategy 3 matched:', name)
          break
        }
      }
    }
  }

  // 4. Name Strategy: Fallback - Look for lines that look like headers (ALL CAPS) near top
  if (!name) {
    const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    // Skip common headers
    const skipWords = ['REPUBLIC', 'DEPARTMENT', 'EDUCATION', 'REGION', 'DIVISION', 'GOVERNMENT', 'PERMIT', 'RECOGNITION', 'SECRETARY', 'OFFICE']
    
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      const line = lines[i]
      const isUpper = line === line.toUpperCase() && /[A-Z]/.test(line)
      const hasSkip = skipWords.some(w => line.includes(w))
      
      if (isUpper && !hasSkip && line.length > 5) {
        name = line
        // console.log('Strategy 4 matched:', name)
        break
      }
    }
  }
  
  // Cleanup Name
  if (name) {
    const prefixMatch = name.match(/(?:Administrator|Principal|Head|Director)\s+of\s+(?:the\s+)?(.*)/i)
    if (prefixMatch && prefixMatch[1]) name = prefixMatch[1].trim()
    name = name.replace(/^Respectfully\s+endorsed\s+to\s+/i, '')
    name = name.replace(/[,.]+$/, '')
  }

  // Address Strategy: "located at", "situated at", "address:"
  const addressMatch = cleanText.match(/(?:located|situated)\s+(?:at|in)\s*[:;]?\s*([^\n]+)/i)
  if (addressMatch && addressMatch[1]) {
    address = addressMatch[1].trim()
  } else {
    // Look for lines containing "City" or "Province" or ending in ZipCode
    const addrLine = cleanText.match(/(?:^|\n)\s*(?:Address|Location)\s*[:.]?\s*([^\n]+)/i)
    if (addrLine && addrLine[1]) {
      address = addrLine[1].trim()
    }
  }

  // Cleanup address trailing words (e.g. "is", "has")
  if (address) {
    address = address.replace(/,?\s+(is|was|has|and)$/i, '').replace(/[.,;:]+$/, '')
  }

  return { schoolName: name, address }
}

function detectStrands(txt) {
  const found = []
  if (/STEM|Science,? Technology,? Engineering,? (?:and|&) Mathematics/i.test(txt)) found.push('STEM')
  if (/ABM|Accountancy,? Business,? (?:and|&) Management/i.test(txt)) found.push('ABM')
  if (/HUMSS|Humanities (?:and|&) Social Sciences/i.test(txt)) found.push('HUMSS')
  if (/GAS|General Academic/i.test(txt)) found.push('GAS')
  if (/TVL|Technical[- ]Vocational[- ]Livelihood/i.test(txt)) found.push('TVL')
  if (/Sports/i.test(txt)) found.push('Sports')
  if (/Arts (?:and|&) Design/i.test(txt)) found.push('Arts and Design')
  return found
}

export function extractPermitDetails(text) {
  if (!text) return []

  const t = cleanOCRText(text)
  const permits = []

  // Strategy 1: Standard GP pattern
  const gpRegex = /(?:Government\s+Permit|GP|Provisional\s+Permit|Authority\s+to\s+Operate|DepEd\s+Permit)(?:\s*\(.*?\))?[\s:.]+(?:No\.?|Number)?[\s:.]*([A-Z0-9\s-]+)[\s,.]*(?:s\.?|series\s+of)\s*(\d{4}[-–]?\d{0,4})/gi
  
  let match
  while ((match = gpRegex.exec(t)) !== null) {
    const pNum = match[1].trim()
    const sYear = match[2].trim()
    if (pNum.length > 25) continue

    const levels = []
    if (/^K[-]/i.test(pNum)) levels.push('Kindergarten')
    else if (/^E[-]/i.test(pNum)) levels.push('Elementary')
    else if (/^S[-]/i.test(pNum) || /^JHS[-]/i.test(pNum)) levels.push('Junior High School') 
    else if (/^SHS[-]/i.test(pNum)) levels.push('Senior High School')

    if (levels.length === 0) {
       const context = t.substring(Math.max(0, match.index - 1000), match.index + 1000)
       if (/Kindergarten/i.test(context)) levels.push('Kindergarten')
       if (/Elementary/i.test(context)) levels.push('Elementary')
       if (/Junior\s*High/i.test(context)) levels.push('Junior High School')
       if (/Senior\s*High/i.test(context)) levels.push('Senior High School')
    }

    permits.push({
      permitNumber: pNum,
      schoolYear: sYear,
      levels: [...new Set(levels)],
      strands: levels.includes('Senior High School') ? detectStrands(t.substring(Math.max(0, match.index - 500), match.index + 2000)) : []
    })
  }

  // Strategy 2: Government Recognition Pattern
  const grRegex = /Government\s+Recognition(?:\s*\(.*?\))?[\s:.]+(?:No\.?|Number)?[\s:.]*([A-Z0-9\s-]+)?[\s,.]*(?:s\.?|series\s+of)\s*(\d{4}[-–]?\d{0,4})/gi
  while ((match = grRegex.exec(t)) !== null) {
      const pNum = match[1] ? match[1].trim() : 'Gov. Rec.'
      if (pNum.length > 25) continue
      const sYear = match[2]
      
      const levels = []
      const context = t.substring(Math.max(0, match.index - 1000), match.index + 1000)
      if (/Kindergarten/i.test(context)) levels.push('Kindergarten')
      if (/Elementary/i.test(context)) levels.push('Elementary')
      if (/Junior\s*High/i.test(context)) levels.push('Junior High School')
      if (/Senior\s*High/i.test(context)) levels.push('Senior High School')

      permits.push({
          permitNumber: pNum,
          schoolYear: sYear,
          levels: [...new Set(levels)],
          strands: levels.includes('Senior High School') ? detectStrands(t.substring(Math.max(0, match.index - 500), match.index + 2000)) : []
      })
  }

  // Strategy 3: Direct format SHS-050, K-123 (for lists)
  const directRegex = /\b(K|E|JHS|SHS|S)\s*[-]?\s*(\d{2,5})\s*[,.]?\s*(?:s\.?|series\s+of)?\s*(\d{4}[-–]?\d{0,4})\b/gi
  while ((match = directRegex.exec(t)) !== null) {
    let prefix = match[1].toUpperCase()
    if (prefix === 'S' && match[2].length <= 3) prefix = 'SHS'
    const pNum = `${prefix}-${match[2]}`
    const sYear = match[3]
    
    if (permits.some(p => p.permitNumber === pNum && p.schoolYear === sYear)) continue
    
    const levels = prefix === 'K' ? ['Kindergarten'] : prefix === 'E' ? ['Elementary'] : prefix === 'JHS' || prefix === 'S' ? ['Junior High School'] : ['Senior High School']
    permits.push({ 
      permitNumber: pNum, 
      schoolYear: sYear, 
      levels, 
      strands: prefix === 'SHS' ? detectStrands(t.substring(Math.max(0, match.index - 500), match.index + 2000)) : [] 
    })
  }

  // Deduplicate
  const uniquePermits = []
  const seen = new Set()
  permits.forEach(p => {
      const key = `${p.permitNumber}-${p.schoolYear}`
      if (!seen.has(key)) {
          seen.add(key)
          uniquePermits.push(p)
      }
  })

  return uniquePermits
}
