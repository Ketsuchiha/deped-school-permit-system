
import { extractSchoolInfoFromText, extractPermitDetails, cleanOCRText } from '../src/utils/permitParser.js'

const tests = [
  {
    name: "Standard Clean Permit",
    input: `
      Republic of the Philippines
      Department of Education
      Region III
      
      GOVERNMENT PERMIT (R-III)
      No. 123 s. 2024
      
      Pursuant to the provisions of Republic Act No. 9155...
      
      GOVERNMENT PERMIT is hereby granted to:
      
      ST. MARY'S ACADEMY OF PAMPANGA
      (School)
      
      located at San Nicolas, San Fernando, Pampanga
      
      to operate the Senior High School Program.
    `,
    expected: {
      schoolName: "ST. MARY'S ACADEMY OF PAMPANGA",
      address: "San Nicolas, San Fernando, Pampanga",
      permitNumber: "123",
      schoolYear: "2024",
      levels: ["Senior High School"]
    }
  },
  {
    name: "Noisy OCR Input",
    input: `
      Republc of the PhiIippines
      Departmnet of Educatlon
      
      GOVERN MENT PERMIT (R-lll)
      No. SHS-005 s. 2023
      
      The HOLY ANGEL UNIVERSITY located in Angeles City, Pampanga
      is hereby granted authrity to operate...
    `,
    expected: {
      schoolName: "HOLY ANGEL UNIVERSITY",
      address: "Angeles City, Pampanga",
      permitNumber: "SHS-005",
      schoolYear: "2023",
      levels: [] // Should not crash, maybe empty if no level keywords found
    }
  },
  {
    name: "Excel Row Format (Single Line)",
    input: `101 ST. JOSEPH SCHOOL San Fernando, Pampanga GP No. 099 s. 2022 Kindergarten, Elementary Renewal`,
    expected: {
      // Logic for single line might fail with current strategies which expect headers/newlines
      // But let's see what we get. The current parser relies on "To:" or "The ... located".
      // We might need to enhance for this case.
      // For now, let's just see if it extracts permit info.
      permitNumber: "099",
      schoolYear: "2022",
      levels: ["Kindergarten", "Elementary"]
    }
  }
]

function runTests() {
  console.log("Running Parser Tests...\n")
  let passed = 0
  let failed = 0

  tests.forEach((t, idx) => {
    console.log(`Test ${idx + 1}: ${t.name}`)
    
    const info = extractSchoolInfoFromText(t.input)
    const permits = extractPermitDetails(t.input)
    // Flatten for simple testing of first permit found
    const firstPermit = permits[0] || {}
    const result = { ...info, ...firstPermit }
    
    const errors = []
    
    if (t.expected.schoolName && result.schoolName !== t.expected.schoolName) {
      errors.push(`Name mismatch: Expected '${t.expected.schoolName}', got '${result.schoolName}'`)
    }
    if (t.expected.address && result.address !== t.expected.address) {
      errors.push(`Address mismatch: Expected '${t.expected.address}', got '${result.address}'`)
    }
    if (t.expected.permitNumber && result.permitNumber !== t.expected.permitNumber) {
      errors.push(`Permit # mismatch: Expected '${t.expected.permitNumber}', got '${result.permitNumber}'`)
    }
    if (t.expected.schoolYear && result.schoolYear !== t.expected.schoolYear) {
      errors.push(`SY mismatch: Expected '${t.expected.schoolYear}', got '${result.schoolYear}'`)
    }
    if (t.expected.levels) {
      const missing = t.expected.levels.filter(l => !result.levels.includes(l))
      if (missing.length > 0) errors.push(`Missing levels: ${missing.join(', ')}`)
    }

    if (errors.length === 0) {
      console.log("✅ PASSED")
      passed++
    } else {
      console.log("❌ FAILED")
      errors.forEach(e => console.log(`   - ${e}`))
      failed++
    }
    console.log('---')
  })

  console.log(`\nResults: ${passed} Passed, ${failed} Failed`)
}

runTests()
