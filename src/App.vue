<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { Shield, Home, Building2, Search, Plus, Upload, Calendar, FileImage, Loader2, CheckCircle, XCircle } from 'lucide-vue-next'
import Tesseract from 'tesseract.js'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import CustomSelect from './components/CustomSelect.vue'

GlobalWorkerOptions.workerSrc = workerSrc

// ─── View state ─────────────────────────────────────────────────────────────
const currentView = ref('search') // 'search' | 'admin'

const API_URL = 'http://localhost:3000/api'

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
})
const schoolFormErrors = ref({})
const createTab = ref('school') // 'school' | 'homeschool'

function setCreateTab(tab) {
  createTab.value = tab
  schoolFormErrors.value = {}
  if (tab === 'homeschool') {
    schoolForm.value = { name: '', type: 'Homeschooling', address: '' }
    setManageTab('application')
  } else {
    schoolForm.value = { name: '', type: 'Private', address: '' } // Default to Private
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
      // Reset form, keep type default
      schoolForm.value = { name: '', type: 'Private', address: '' }
      schoolFormErrors.value = {}
      showToast('School created successfully!', 'success')
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

/** Extract permit number and school year from OCR text */
function extractPermitDetails(text) {
  if (!text || !text.trim()) return { permitNumber: '', schoolYear: '', levels: [] }
  
  const t = text.replace(/\s+/g, ' ').trim()
  let permitNumber = ''
  let schoolYear = ''
  const detectedLevels = new Set()

  // 1. Detect Levels based on prefixes (K, E, S, SHS, JHS) and Explicit Text
  
  // Explicit Text Detection (Prioritized)
  const hasKindergarten = /Kindergarten/i.test(t)
  const hasElementary = /Elementary/i.test(t)
  const hasJuniorHigh = /Junior\s*High\s*School/i.test(t)
  const hasSeniorHigh = /Senior\s*High\s*School/i.test(t)

  // Prefix checks
  if (/K\s*[-–]\s*\d+/i.test(t) || hasKindergarten) detectedLevels.add('Kindergarten')
  if (/E\s*[-–]\s*\d+/i.test(t) || hasElementary) detectedLevels.add('Elementary')
  
  // Check for JHS/SHS/S
  if (/JHS\s*[-–]\s*\d+/i.test(t) || hasJuniorHigh) detectedLevels.add('Junior High School')
  if (/SHS\s*[-–]\s*\d+/i.test(t) || hasSeniorHigh) detectedLevels.add('Senior High School')
  
  // "S" for Junior High School (as per user request)
  // Only add if we don't already have specific JHS/SHS info, OR if it's explicitly JHS
  // Actually user said S -> Junior High.
  if (/S(?!H)\s*[-–]\s*\d+/i.test(t)) {
     detectedLevels.add('Junior High School')
  }

  // Refinement: If "Senior High School" is explicitly mentioned but "Junior High School" is NOT,
  // ensure we didn't accidentally add Junior High due to ambiguous "S" or "High School" matches.
  if (hasSeniorHigh && !hasJuniorHigh) {
    detectedLevels.delete('Junior High School')
  }
  // Conversely, if JHS is explicit and SHS is not
  if (hasJuniorHigh && !hasSeniorHigh) {
    detectedLevels.delete('Senior High School')
  }

  // 2. Extract Permit Number(s)
  // Collect all valid permit numbers found to populate the field
  const foundPermits = []
  
  // Priority patterns for extraction
  const specificPatterns = [
    // /(DEPED\s*[-–]\s*[A-Z0-9]+[-–][A-Z0-9-]{5,})/gi, // REMOVED per user request (only K, E, S, SHS)
    /(SHS\s*-\s*\d+)/gi,
    /(JHS\s*-\s*\d+)/gi,
    /(K\s*-\s*\d+)/gi,
    /(E\s*-\s*\d+)/gi,
    /(S\s*-\s*\d+)/gi, // Generic S-
    /No\.?\s*([A-Z]+-[0-9]+)/gi, // Generic No. XXX-000
  ]
  
  // Try to find specific coded permits first
  for (const re of specificPatterns) {
    const matches = t.match(re)
    if (matches) {
      matches.forEach(m => foundPermits.push(m.trim()))
    }
  }

  // If no specific codes found, fallback to generic patterns
  if (foundPermits.length === 0) {
    const genericPatterns = [
        /Government\s*Permit\s*(?:\(.*\))?\s*No\.?\s*[._\-\s]*([A-Z0-9-]+)/i,
        /No\.?\s*[._\-\s]*([A-Z0-9-]+)/i,
        /Permit\s*No\.?\s*[._\-\s]*([A-Z0-9-]+)/i,
        /Permit\s*(?:#|number)?\s*:?\s*[._\-\s]*([A-Z0-9-]+)/i,
        /([A-Z]{1,3}\s*-\s*\d+)/i, 
    ]
    
    for (const re of genericPatterns) {
        const m = t.match(re)
        if (m && m[1]) {
            foundPermits.push(m[1].trim())
            break // Just take the first good generic match
        }
    }
  }

  // Deduplicate found permits
  permitNumber = [...new Set(foundPermits)]
    .filter(p => {
      const up = p.toUpperCase()
      if (up.startsWith('DEPED')) return false // Explicit exclude
      // Strict whitelist: K, E, S (includes SHS), J (includes JHS)
      return /^(K|E|S|J)/.test(up)
    })
    .join(', ')

  // 3. Extract Year / Series
  // Priority: "s. 2018"
  const yearPatterns = [
    /s\.?\s*(20\d{2})/i,             // Matches "s. 2018" (Strictly 2000+)
    /series\s*of\s*(20\d{2})/i,      // Matches "series of 2018" (Strictly 2000+)
    /SY\s*(20\d{2}-\d{4})/i,         // Matches "SY 2018-2019"
    /School\s*Year\s*.*(20\d{2}\s*-\s*20\d{2})/i, // Flexible: "School Year _____ 2018-2019", strictly 2000+
    /(20\d{2})\s*-\s*(20\d{2})/,   // Matches "2018-2019" (Strictly 2000+)
  ]

  for (const re of yearPatterns) {
    const m = t.match(re)
    if (m && m[1]) {
      // If we matched a full range like "2018-2019"
      if (m[1].length === 9 && m[1].includes('-')) {
        schoolYear = m[1].trim()
      } else if (m[2]) {
         // Matches "2018 - 2019" -> "2018-2019"
         schoolYear = `${m[1]}-${m[2]}`
      } else if (m[1].length === 4) {
        // Matches "2018" -> Convert to "2018-2019"
        const y = parseInt(m[1], 10)
        schoolYear = `${y}-${y + 1}`
      }
      break
    }
  }

  // 4. Extract Strands (Only if Senior High School is detected/relevant)
  const detectedStrands = new Set()
  // Keywords for strands
  const strandKeywords = [
    { code: 'STEM', patterns: [/STEM/i, /Science\s*Technology\s*Engineering\s*(?:and)?\s*Mathematics/i] },
    { code: 'ABM', patterns: [/ABM/i, /Accountancy\s*Business\s*(?:and)?\s*Management/i] },
    { code: 'HUMSS', patterns: [/HUMSS/i, /Humanities\s*(?:and)?\s*Social\s*Sciences/i] },
    { code: 'GAS', patterns: [/GAS/i, /General\s*Academic\s*Strand/i] },
    { code: 'TVL', patterns: [/TVL/i, /Technical\s*Vocational\s*Livelihood/i] },
    { code: 'Arts and Design', patterns: [/Arts\s*(?:and)?\s*Design/i] },
    { code: 'Sports', patterns: [/Sports\s*Track/i] }
  ]

  // Only scan for strands if SHS is likely or explicitly checked
  // (We'll just scan anyway and let the UI decide to show it if SHS is picked)
  strandKeywords.forEach(strand => {
    if (strand.patterns.some(p => p.test(t))) {
      detectedStrands.add(strand.code)
    }
  })

  return { permitNumber, schoolYear, levels: Array.from(detectedLevels), strands: Array.from(detectedStrands) }
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
  // Don't clear schoolYear immediately, wait for OCR to potentially overwrite it
  
  ocrLoading.value = true
  try {
    let extracted = { permitNumber: '', schoolYear: '' }
    let fullText = ''
    
    if (file.type.startsWith('image/')) {
      const { data } = await Tesseract.recognize(file, 'eng')
      fullText = data.text
      extracted = extractPermitDetails(fullText)
    } else if (file.type === 'application/pdf') {
      const buf = await file.arrayBuffer()
      const pdf = await getDocument({ data: buf }).promise
      
      // Scan up to 50 pages (effectively whole document for most permits)
      const maxPages = Math.min(pdf.numPages, 50)
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i)
        
        // Try text content first (fastest)
        const content = await page.getTextContent()
        let pageText = content.items.map((it) => ('str' in it ? it.str : '')).join(' ')
        
        // If text content is sparse (likely scanned PDF), render to image and OCR
        if (pageText.replace(/\s/g, '').length < 50) {
           try {
             const viewport = page.getViewport({ scale: 2.0 }) // Higher scale for better OCR
             const canvas = document.createElement('canvas')
             const context = canvas.getContext('2d')
             canvas.height = viewport.height
             canvas.width = viewport.width
             
             await page.render({ canvasContext: context, viewport: viewport }).promise
             
             // Convert to blob/url for Tesseract
             const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
             const { data } = await Tesseract.recognize(blob, 'eng')
             pageText = data.text
           } catch (ocrErr) {
             console.error('Page OCR failed:', ocrErr)
             // fallback to whatever text we had
           }
        }
        
        fullText += pageText + ' '
      }
      extracted = extractPermitDetails(fullText)
    }

    permitForm.value.extractedText = fullText

    if (extracted.permitNumber) {
      permitForm.value.permitNumber = extracted.permitNumber
    }
    if (extracted.schoolYear) {
      permitForm.value.schoolYear = extracted.schoolYear
    }
    
    if (extracted.levels && extracted.levels.length > 0) {
      const currentLevels = new Set(permitForm.value.levels)
      extracted.levels.forEach(l => currentLevels.add(l))
      permitForm.value.levels = Array.from(currentLevels)
      showToast(`Detected levels: ${extracted.levels.join(', ')}`, 'success')
    }

    if (extracted.strands && extracted.strands.length > 0) {
      // Merge detected strands
      const currentStrands = new Set(permitForm.value.strands)
      extracted.strands.forEach(s => currentStrands.add(s))
      permitForm.value.strands = Array.from(currentStrands)
      // Note: Strands UI is only visible if Senior High School level is also detected/selected
    }
    
    // Check school name match immediately if school is selected
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
    // OCR failed, keep manual entry possible
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
                v-for="(p, index) in group.permits" 
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
                
                <div class="flex items-center justify-between">
                  <div class="text-sm text-slate-600">
                    <span v-if="p.permitNumber">Permit No. {{ p.permitNumber }}</span>
                    <span v-if="p.permitNumber" class="text-slate-300 mx-2">|</span>
                    <span>SY {{ p.schoolYear }}</span>
                  </div>
                  
                  <button
                    v-if="p.filePreviewUrl"
                    type="button"
                    @click="openPreview(p)"
                    class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-sky-700 bg-sky-50 rounded-lg hover:bg-sky-100 transition-colors"
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
          <!-- School Form Fields -->
          <div v-if="createTab === 'school'" class="space-y-4">
            <div>
              <label for="schoolName" class="block text-sm font-medium text-slate-700 mb-1">
                School Name <span class="text-red-500">*</span>
              </label>
              <input
                id="schoolName"
                v-model="schoolForm.name"
                type="text"
                placeholder="e.g., St. Mary's Academy"
                class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none"
                :class="{ 'border-red-500': schoolFormErrors.name }"
              />
              <p v-if="schoolFormErrors.name" class="mt-1 text-sm text-red-600">{{ schoolFormErrors.name }}</p>
            </div>
            <!-- School Type is now implicitly Private -->
            <!--
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">School Type <span class="text-red-500">*</span></label>
              <div class="flex gap-4">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    v-model="schoolForm.type"
                    value="Private"
                    class="text-sky-600 focus:ring-sky-500"
                    checked
                    disabled
                  />
                  <span class="text-slate-700">Private School</span>
                </label>
              </div>
            </div>
            -->
          </div>

          <!-- Homeschooling Form Fields -->
          <div v-else class="space-y-4">
            <div>
              <label for="providerName" class="block text-sm font-medium text-slate-700 mb-1">
                Homeschooling Provider Name <span class="text-red-500">*</span>
              </label>
              <input
                id="providerName"
                v-model="schoolForm.name"
                type="text"
                placeholder="e.g., Happy Homeschool Center"
                class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none"
                :class="{ 'border-red-500': schoolFormErrors.name }"
              />
              <p v-if="schoolFormErrors.name" class="mt-1 text-sm text-red-600">{{ schoolFormErrors.name }}</p>
            </div>
            <!-- Hidden type is already set to 'Homeschooling' by setCreateTab -->
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

          <button
            type="submit"
            class="w-full py-2.5 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 transition-colors"
          >
            {{ createTab === 'school' ? 'Create School' : 'Create Provider' }}
          </button>
        </form>
      </section>

      <!-- Upload Permit card -->
      <section class="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div class="flex items-center gap-2">
            <div class="p-1.5 rounded-lg" :class="manageTab === 'permit' ? 'bg-emerald-100 text-emerald-600' : 'bg-orange-100 text-orange-600'">
              <Upload v-if="manageTab === 'permit'" :size="20" />
              <FileImage v-else :size="20" />
            </div>
            <h3 class="text-lg font-semibold text-slate-800">
              {{ manageTab === 'permit' ? 'Upload Permit' : 'Add Application Data' }}
            </h3>
          </div>

          <!-- Tabs -->
          <div class="flex bg-slate-100 p-1 rounded-lg self-start sm:self-auto">
            <button
              type="button"
              @click="setManageTab('permit')"
              class="px-4 py-1.5 text-sm font-medium rounded-md transition-all"
              :class="manageTab === 'permit' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
            >
              School Permits
            </button>
            <button
              type="button"
              @click="setManageTab('application')"
              class="px-4 py-1.5 text-sm font-medium rounded-md transition-all"
              :class="manageTab === 'application' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
            >
              Homeschooling
            </button>
          </div>
        </div>

        <form @submit.prevent="submitPermit" class="space-y-4">
          <div>
            <label for="selectSchool" class="block text-sm font-medium text-slate-700 mb-1">
              {{ manageTab === 'permit' ? 'Select School' : 'Select Provider' }} <span class="text-red-500">*</span>
            </label>
            <CustomSelect
              v-model="permitForm.schoolId"
              :options="manageTab === 'permit' 
                ? schoolOptions.map(s => ({ value: s.id, label: s.name })) 
                : homeschoolOptions.map(s => ({ value: s.id, label: s.name }))"
              :placeholder="manageTab === 'permit' ? '-- Select School --' : '-- Select Provider --'"
              :error="!!permitFormErrors.schoolId"
            />
            <p v-if="permitFormErrors.schoolId" class="mt-1 text-sm text-red-600">{{ permitFormErrors.schoolId }}</p>
            <p v-if="manageTab === 'permit' && !schoolOptions.length" class="mt-1 text-sm text-amber-600">Create a school above first.</p>
            <p v-if="manageTab === 'application' && !homeschoolOptions.length" class="mt-1 text-sm text-amber-600">Create a homeschooling provider above first.</p>
          </div>
          <!-- Multiple Levels Checkboxes -->
          <div>
            <label class="block text-sm font-medium text-slate-700 mb-2">Select Level(s)/Program(s) <span class="text-red-500">*</span></label>
            <div class="grid grid-cols-2 gap-3">
              <label 
                v-for="opt in levelOptions" 
                :key="opt.value" 
                class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-200"
                :class="permitForm.levels.includes(opt.value) ? 'border-sky-500 bg-sky-50' : 'border-slate-200 hover:border-slate-300'"
              >
                <div 
                  class="w-5 h-5 rounded border flex items-center justify-center transition-colors"
                  :class="permitForm.levels.includes(opt.value) ? 'bg-sky-500 border-sky-500' : 'border-slate-300 bg-white'"
                >
                  <CheckCircle v-if="permitForm.levels.includes(opt.value)" class="w-3.5 h-3.5 text-white" />
                </div>
                <input 
                  type="checkbox" 
                  :value="opt.value" 
                  class="hidden"
                  @change="toggleLevel(opt.value)"
                  :checked="permitForm.levels.includes(opt.value)"
                >
                <span class="text-sm font-medium" :class="permitForm.levels.includes(opt.value) ? 'text-sky-900' : 'text-slate-700'">
                  {{ opt.label }}
                </span>
              </label>
            </div>
            <p v-if="permitFormErrors.levels" class="mt-1 text-sm text-red-500">{{ permitFormErrors.levels }}</p>
          </div>
          <div>
            <label for="schoolYear" class="block text-sm font-medium text-slate-700 mb-1">
              School Year <span class="text-red-500">*</span>
            </label>
            <div class="relative">
              <Calendar class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="18" />
              <input
                id="schoolYear"
                v-model="permitForm.schoolYear"
                type="text"
                placeholder="YYYY-YYYY (e.g. 2024-2025)"
                class="w-full pl-10 pr-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none"
                :class="{ 'border-red-500': permitFormErrors.schoolYear }"
                maxlength="9"
              />
            </div>
            <p v-if="permitFormErrors.schoolYear" class="mt-1 text-sm text-red-600">{{ permitFormErrors.schoolYear }}</p>
          </div>

          <!-- Strands Checklist (Only if Senior High School is selected) -->
          <div v-if="permitForm.levels.includes('Senior High School')" class="space-y-2 bg-slate-50 p-4 rounded-lg border border-slate-200">
            <label class="block text-sm font-medium text-slate-800">Senior High School Strands</label>
            <div class="grid grid-cols-2 gap-2">
              <label 
                v-for="strand in ['STEM', 'ABM', 'HUMSS', 'GAS', 'TVL', 'Arts and Design', 'Sports']" 
                :key="strand" 
                class="flex items-center gap-2 cursor-pointer"
              >
                <input 
                  type="checkbox" 
                  :value="strand" 
                  v-model="permitForm.strands"
                  class="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                >
                <span class="text-sm text-slate-700">{{ strand }}</span>
              </label>
            </div>
          </div>
          
          <div v-if="manageTab === 'permit'">
            <label class="block text-sm font-medium text-slate-700 mb-1">Upload Copy <span class="text-red-500">*</span></label>
            <input
              type="file"
              accept="image/*,application/pdf"
              class="block w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-sky-50 file:text-sky-700 file:font-medium hover:file:bg-sky-100"
              :class="{ 'border-red-500': permitFormErrors.upload }"
              @change="onPermitFileChange"
            />
            <div v-if="permitForm.filePreviewUrl" class="mt-2 rounded-lg border border-slate-200 overflow-hidden bg-slate-50">
              <a
                :href="permitForm.filePreviewUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="block"
              >
                <template v-if="permitForm.file?.type?.startsWith('image/')">
                  <img
                    :src="permitForm.filePreviewUrl"
                    alt="Permit preview"
                    class="w-full max-h-40 object-contain"
                  />
                </template>
                <template v-else>
                  <div class="p-3 text-sm text-slate-700">{{ permitForm.fileName }}</div>
                </template>
              </a>
            </div>
            <p v-if="permitFormErrors.upload" class="mt-1 text-sm text-red-600">{{ permitFormErrors.upload }}</p>
            <p class="mt-1 text-xs text-slate-500">The system reads permit number from images or PDFs.</p>
          </div>

          <div v-if="manageTab === 'permit' && (permitForm.filePreviewUrl || ocrLoading)">
            <label for="permitNumber" class="block text-sm font-medium text-slate-700 mb-1">Permit Number</label>
            <div class="relative">
              <input
                id="permitNumber"
                v-model="permitForm.permitNumber"
                type="text"
                placeholder="Auto-filled from document or type manually"
                class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none pr-10"
                :class="{ 'border-red-500': permitFormErrors.permitNumber, 'border-emerald-500': permitForm.permitNumber && !permitFormErrors.permitNumber }"
              />
              <Loader2
                v-if="ocrLoading"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-sky-500 animate-spin"
                :size="18"
              />
              <CheckCircle
                v-else-if="permitForm.permitNumber && !permitFormErrors.permitNumber && /^[A-Z0-9-]+$/i.test(permitForm.permitNumber) && /\d/.test(permitForm.permitNumber)"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500"
                :size="18"
              />
            </div>
            <p v-if="permitFormErrors.permitNumber" class="mt-1 text-sm text-red-600">{{ permitFormErrors.permitNumber }}</p>
            <p v-else-if="permitForm.permitNumber && /^[A-Z0-9-]+$/i.test(permitForm.permitNumber) && /\d/.test(permitForm.permitNumber)" class="mt-1 text-xs text-emerald-600">
              Valid Government Permit Format
            </p>
          </div>
          
          <button
            type="submit"
            class="w-full py-2.5 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 transition-colors"
          >
            {{ manageTab === 'permit' ? 'Submit Permit' : 'Submit Application Data' }}
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
        <div class="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-100">
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
