
// Helper to clean common OCR errors
export function cleanOCRText(text) {
  if (!text) return ''
  return text
    .replace(/SCH00L/gi, 'SCHOOL')
    .replace(/ACAD3MY/gi, 'ACADEMY')
    .replace(/EDUC4TI0N/gi, 'EDUCATION')
    .replace(/REPVBLIC/gi, 'REPUBLIC')
    .replace(/D3PARTMENT/gi, 'DEPARTMENT')
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

/**
 * Calculates a confidence score (0-100) based on extracted fields.
 * If essential fields are missing, confidence drops.
 */
export function calculateConfidence(info) {
  let score = 100
  const errors = []
  
  if (!info.schoolName) {
    score -= 40
    errors.push('MISSING_SCHOOL_NAME')
  } else {
    if (info.schoolName.length < 5) {
      score -= 20
      errors.push('SCHOOL_NAME_TOO_SHORT')
    }
    if (/^(operate|establish|maintain|support|conduct|manage)\b/i.test(info.schoolName)) {
      score -= 50
      errors.push('POSSIBLE_INVALID_NAME')
    }
    // Boost score if it contains valid school keywords
    if (/(SCHOOL|ACADEMY|INSTITUTE|COLLEGE|UNIVERSITY|MONTESSORI|LEARNING|CENTER)/i.test(info.schoolName)) {
        score += 5
    }
  }
  
  if (!info.address) {
    score -= 30
    errors.push('MISSING_ADDRESS')
  } else if (info.address.length < 10) {
    score -= 10
    errors.push('ADDRESS_LIKELY_INCOMPLETE')
  }

  return { score: Math.max(0, score), errors }
}

export function extractSchoolInfoFromText(text) {
  if (!text) return { schoolName: '', address: '', confidence: 0, errors: ['NO_TEXT_EXTRACTED'] }

  const cleanText = cleanOCRText(text)
  
  let textToAnalyze = cleanText
  const permitHeaderMatch = cleanText.match(/(?:GOVERNMENT\s*(?:RECOGNITION|PERMIT)|AUTHORITY\s+TO\s+OPERATE)/i)
  if (permitHeaderMatch) {
     textToAnalyze = cleanText.substring(permitHeaderMatch.index)
  }

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

  let cleanTextForName = textToAnalyze
  for (const marker of signatureMarkers) {
    const match = cleanTextForName.match(marker)
    if (match) {
       cleanTextForName = cleanTextForName.substring(0, match.index).trim()
       break 
    }
  }

  let name = ''
  let address = ''

  // 1. Name Strategy: "The <Name> located/situated at" (Most reliable)
  const theMatch = cleanTextForName.match(/(?:^|\n)\s*(?:The|That)\s+([A-Z0-9\s.,&'()-]+?)\s+(?:located|situated|locat[e3]d|situat[e3]d)\s+(?:at|in)/i)
  if (theMatch && theMatch[1]) {
    name = theMatch[1].trim()
  }

  // 2. Name Strategy: Explicit "To: <Name>"
  if (!name) {
    const toMatch = cleanTextForName.match(/(?:(?:^|\n)\s*To|(?:^|\n).*?(?:Granted\s+to|Issued\s+to))[:\s]*\n*([A-Z0-9\s.,&'()-]+?)(?:\n+\(School\)|\s+located\s+at|\s+to\s+operate|\s+for\s+the|\n|$)/i)
    if (toMatch && toMatch[1]) {
      const candidate = toMatch[1].trim()
      // Filter out false positives like "operate", "establish"
      if (!candidate.includes('Regional Director') && 
          candidate.length > 3 &&
          !/^(operate|establish|maintain|support|conduct|manage)\b/i.test(candidate)) {
        name = candidate
      }
    }
  }

  // 3. Name Strategy: Explicit Labels "(School)"
  if (!name) {
    const lines = cleanTextForName.split('\n').map(l => l.trim())
    for (let i = 0; i < lines.length; i++) {
      if (/\(School\)/i.test(lines[i]) || /\(Name of School\)/i.test(lines[i])) {
        if (i > 0 && lines[i-1].length > 3 && !/^To$/i.test(lines[i-1])) {
          name = lines[i-1]
          break
        }
      }
    }
  }

  // 4. Name Strategy: Fallback - Look for lines that look like headers (ALL CAPS) near top
  if (!name) {
    const lines = cleanTextForName.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    // Skip common headers
    const skipWords = ['REPUBLIC', 'DEPARTMENT', 'EDUCATION', 'REGION', 'DIVISION', 'GOVERNMENT', 'PERMIT', 'RECOGNITION', 'SECRETARY', 'OFFICE', 'NOTICE']
    // Valid School Suffixes/Keywords to boost confidence
    const schoolKeywords = ['SCHOOL', 'ACADEMY', 'INSTITUTE', 'COLLEGE', 'UNIVERSITY', 'MONTESSORI', 'LEARNING', 'CENTER', 'KINDER', 'PRESCHOOL']

    for (let i = 0; i < Math.min(lines.length, 20); i++) {
      const line = lines[i]
      const isUpper = line === line.toUpperCase() && /[A-Z]/.test(line)
      const hasSkip = skipWords.some(w => line.includes(w))
      const hasSchoolKeyword = schoolKeywords.some(w => line.includes(w))
      
      if (isUpper && !hasSkip && line.length > 5) {
        // If it contains a school keyword, it's very likely the name
        if (hasSchoolKeyword) {
          name = line
          break
        }
        // Otherwise, keep it as a candidate if we haven't found one yet
        if (!name) name = line
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
  const addressMatch = cleanTextForName.match(/(?:located|situated|locat[e3]d|situat[e3]d)\s+(?:at|in)\s*[:;]?\s*([\s\S]+?)(?=\s+(?:approving|approves|granting|granted|hereby|which|where|to\s+operate|subject\s+to|pursuant|under|following|through|is\s+hereby|\(School\)|\.|,?\s*and\s*|;)|$)/i)
  if (addressMatch && addressMatch[1]) {
    address = addressMatch[1].trim()
  } else {
    // Look for lines containing "City" or "Province" or ending in ZipCode
    const addrLine = cleanTextForName.match(/(?:^|\n)\s*(?:Address|Location)\s*[:.]?\s*([^\n]+)/i)
    if (addrLine && addrLine[1]) {
      address = addrLine[1].trim()
    }
  }

  if (!address && name) {
    const lines = cleanTextForName.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    const idx = lines.findIndex(l => l.includes(name))
    if (idx !== -1) {
      const after = []
      if (idx + 1 < lines.length) after.push(lines[idx + 1])
      if (idx + 2 < lines.length && !/\(School\)/i.test(lines[idx + 2]) && !/Track\b/i.test(lines[idx + 2])) {
        after.push(lines[idx + 2])
      }
      let candidate = after.join(' ').trim()
      if (candidate) {
        candidate = candidate.replace(/\(Complete Address\)/i, '').trim()
        address = candidate
      }
    }
  }

  // Cleanup address
  if (address) {
    // Remove common trailing phrases and everything after them
    address = address.replace(/(?:\n|^)\s*(?:for\s+the|effective|subject\s+to|granted\s+to|issued\s+to)[\s\S]*$/i, '')
    address = address.replace(/,?\s+(is|was|has|and)$/i, '').replace(/[.,;:]+$/, '')
  }

  const { score, errors } = calculateConfidence({ schoolName: name, address })

  return { schoolName: name, address, confidence: score, errors }
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

function findSchoolYearInContext(context) {
  const match = context.match(/(?:SY|S\.Y\.|School\s+Year)[\s:.]*(\d{4}[-–]\d{4})/i)
  return match ? match[1] : null
}

export function extractPermitDetails(text) {
  if (!text) return []

  const t = cleanOCRText(text)
  const permits = []

  const gpRegex = /(?:Government\s*Permit|GP|Provisional\s+Permit|Authority\s+to\s+Operate|DepEd\s*Permit)(?:\s*\(.*?\))?[\s:.]+(?:No\.?|Number|#)?[\s:.]*([A-Z0-9\s-]+)[\s,.]*(?:s\.?|series\s+of)\s*(\d{4}[-–]?\d{0,4})/gi
  
  let match
  while ((match = gpRegex.exec(t)) !== null) {
    const pNum = match[1].trim()
    let sYear = match[2].trim()
    if (pNum.length > 25) continue

    const context = t.substring(Math.max(0, match.index - 1000), match.index + 1000)

    // Refine School Year if it's just a single year (e.g. "s. 2024")
    if (sYear.length === 4) {
      const betterYear = findSchoolYearInContext(context)
      if (betterYear) sYear = betterYear
    }

    const levels = []
    if (/^K[-]/i.test(pNum)) levels.push('Kindergarten')
    else if (/^E[-]/i.test(pNum)) levels.push('Elementary')
    else if (/^S[-]/i.test(pNum) || /^JHS[-]/i.test(pNum)) levels.push('Junior High School') 
    else if (/^SHS[-]/i.test(pNum)) levels.push('Senior High School')

    if (levels.length === 0) {
       if (/(?:Kindergarten|Pre[- ]?Elementary|Preschool)/i.test(context)) levels.push('Kindergarten')
       if (/(?:Elementary|Grades\s+1[-–]6|Primary)/i.test(context)) levels.push('Elementary')
       if (/(?:Junior\s+High|JHS|Grades\s+7[-–]10)/i.test(context)) levels.push('Junior High School')
       if (/(?:Senior\s+High|SHS|Grades\s+11[-–]12)/i.test(context)) levels.push('Senior High School')
    }

    permits.push({
      permitNumber: pNum,
      schoolYear: sYear,
      levels: [...new Set(levels)],
      strands: levels.includes('Senior High School') ? detectStrands(context) : []
    })
  }

  const grRegex = /Government\s*Recognition(?:\s*\(.*?\))?[\s:.]+(?:No\.?|Number|#)?[\s:.]*([A-Z0-9\s-]+)?[\s,.]*(?:s\.?|series\s+of)\s*(\d{4}[-–]?\d{0,4})/gi
  while ((match = grRegex.exec(t)) !== null) {
      const pNum = match[1] ? match[1].trim() : 'Gov. Rec.'
      if (pNum.length > 25) continue
      let sYear = match[2]
      
      const context = t.substring(Math.max(0, match.index - 1000), match.index + 1000)
      
      if (sYear.length === 4) {
        const betterYear = findSchoolYearInContext(context)
        if (betterYear) sYear = betterYear
      }

      const levels = []
      if (/(?:Kindergarten|Pre[- ]?Elementary|Preschool)/i.test(context)) levels.push('Kindergarten')
      if (/(?:Elementary|Grades\s+1[-–]6|Primary)/i.test(context)) levels.push('Elementary')
      if (/(?:Junior\s+High|JHS|Grades\s+7[-–]10)/i.test(context)) levels.push('Junior High School')
      if (/(?:Senior\s+High|SHS|Grades\s+11[-–]12)/i.test(context)) levels.push('Senior High School')

      permits.push({
          permitNumber: pNum,
          schoolYear: sYear,
          levels: [...new Set(levels)],
          strands: levels.includes('Senior High School') ? detectStrands(context) : []
      })
  }

  // Strategy 3: Direct format SHS-050, K-123 (for lists)
  const directRegex = /\b(K|E|JHS|SHS|S)\s*[-]?\s*(\d{2,5})\s*[,.]?\s*(?:s\.?|series\s+of)?\s*(\d{4}[-–]?\d{0,4})\b/gi
  while ((match = directRegex.exec(t)) !== null) {
    let prefix = match[1].toUpperCase()
    if (prefix === 'S' && match[2].length <= 3) prefix = 'SHS'
    const pNum = `${prefix}-${match[2]}`
    let sYear = match[3]

    if (sYear.length === 4) {
        // Look ahead for SY
        const context = t.substring(match.index, match.index + 100)
        const betterYear = findSchoolYearInContext(context)
        if (betterYear) sYear = betterYear
    }
    
    if (permits.some(p => p.permitNumber === pNum && p.schoolYear === sYear)) continue
    
    const levels = prefix === 'K' ? ['Kindergarten'] : prefix === 'E' ? ['Elementary'] : prefix === 'JHS' || prefix === 'S' ? ['Junior High School'] : ['Senior High School']
    permits.push({ 
      permitNumber: pNum, 
      schoolYear: sYear, 
      levels, 
      strands: prefix === 'SHS' ? detectStrands(t.substring(Math.max(0, match.index - 500), match.index + 2000)) : [] 
    })
  }

  // Deduplicate and Merge
  const uniquePermits = []
  const permitMap = new Map()

  permits.forEach(p => {
    // Normalize Permit Number for key (remove spacing differences)
    const key = p.permitNumber.replace(/\s+/g, '').toUpperCase()
    
    if (permitMap.has(key)) {
      const existing = permitMap.get(key)
      // Merge logic: prefer longer school year (e.g. 2024-2025 over 2024)
      if (p.schoolYear.length > existing.schoolYear.length) {
        existing.schoolYear = p.schoolYear
      }
      // Merge levels
      const mergedLevels = new Set([...existing.levels, ...p.levels])
      existing.levels = Array.from(mergedLevels)
      
      // Merge strands
      const mergedStrands = new Set([...existing.strands, ...p.strands])
      existing.strands = Array.from(mergedStrands)
    } else {
      permitMap.set(key, p)
      uniquePermits.push(p)
    }
  })

  return uniquePermits
}
