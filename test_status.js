
function parseSchoolYearEnd(schoolYear) {
  if (!schoolYear || typeof schoolYear !== 'string') return null
  const parts = schoolYear.trim().split(/[-–]/).map(p => p.trim()) // Handle en-dash too
  
  if (parts.length === 2) {
      let start = parseInt(parts[0], 10)
      let end = parseInt(parts[1], 10)
      
      if (isNaN(start) || isNaN(end)) return null
      
      // Handle 2-digit end year (e.g. 2018-19)
      if (parts[1].length === 2) {
          end = 2000 + end
      }
      
      return end
  }
  
  const single = parseInt(schoolYear.trim(), 10)
  return !isNaN(single) ? single + 1 : null
}

function getStatus(schoolYear, mockTodayDate) {
  if (!schoolYear) return { label: 'Unknown', color: 'gray' }
  const endYear = parseSchoolYearEnd(schoolYear)
  if (!endYear) return { label: 'Invalid SY', color: 'gray' }

  const expirationDate = new Date(endYear, 11, 31) // Dec 31
  const now = mockTodayDate ? new Date(mockTodayDate) : new Date()
  now.setHours(0, 0, 0, 0)
  expirationDate.setHours(0, 0, 0, 0)
  const daysPast = Math.floor((now - expirationDate) / (24 * 60 * 60 * 1000))

  // console.log(`SY: ${schoolYear}, End: ${endYear}, Exp: ${expirationDate.toDateString()}, Now: ${now.toDateString()}, DaysPast: ${daysPast}`)

  if (daysPast <= 0) {
      // Check if nearing expiration (e.g. within 90 days)
      if (daysPast > -90) return { label: 'Expiring Soon', color: 'orange' }
      return { label: 'Operational', color: 'green' }
  }
  if (daysPast <= 365) return { label: 'For Renewal', color: 'yellow' }
  return { label: 'Closed', color: 'red' }
}

function hasPermitGap(permits) {
  if (!permits || permits.length === 0) return true
  const years = permits
    .map(p => parseSchoolYearEnd(p.schoolYear))
    .filter(y => y != null)
    .sort((a, b) => a - b)
  if (years.length === 0) return true
  for (let i = 1; i < years.length; i++) {
    if (years[i] - years[i - 1] > 1) return true
  }
  return false
}

function getOverallSchoolStatus(permits, mockTodayDate) {
  if (!permits || permits.length === 0) return { label: 'No Records', color: 'gray' }
  if (hasPermitGap(permits)) return { label: 'Closed', color: 'red' }

  const sorted = [...permits].sort((a, b) => {
    const ya = parseSchoolYearEnd(a.schoolYear) || 0
    const yb = parseSchoolYearEnd(b.schoolYear) || 0
    return yb - ya
  })
  return getStatus(sorted[0].schoolYear, mockTodayDate)
}

// ─── Tests ───
const today = '2026-02-04'
console.log('--- Unit Tests ---')
console.log('2025-2026 (Active):', getStatus('2025-2026', today).label) 
console.log('2024-2025 (Expired recently):', getStatus('2024-2025', today).label) 
console.log('2018-2019 (Old):', getStatus('2018-2019', today).label)

console.log('\n--- Renewal Workflow Simulation ---')

// 1. Initial State: School has old permit
let schoolPermits = [
    { permitNumber: 'P-001', schoolYear: '2024-2025' }
]
console.log('Initial Permits:', schoolPermits.map(p => p.schoolYear))
let status = getOverallSchoolStatus(schoolPermits, today)
console.log(`Current Status (${today}):`, status.label)
if (status.label !== 'For Renewal') console.error('FAIL: Should be For Renewal')
else console.log('PASS: Initial status correct')

// 2. User uploads renewal permit
console.log('\nUser uploads renewal permit for 2025-2026...')
schoolPermits.push({ permitNumber: 'P-002', schoolYear: '2025-2026' })
console.log('Updated Permits:', schoolPermits.map(p => p.schoolYear))

// 3. Check Status again
status = getOverallSchoolStatus(schoolPermits, today)
console.log(`New Status (${today}):`, status.label)
if (status.label !== 'Operational') console.error('FAIL: Should be Operational')
else console.log('PASS: Status updated to Operational')

// 4. Simulate Future (End of School Year + 1 day)
// End of SY 2025-2026 is Dec 31, 2026.
// Let's check Jan 1, 2027.
const futureDate = '2027-01-01'
console.log(`\nFast forward to ${futureDate}...`)
status = getOverallSchoolStatus(schoolPermits, futureDate)
console.log(`Future Status (${futureDate}):`, status.label)
if (status.label !== 'For Renewal') console.error('FAIL: Should be For Renewal')
else console.log('PASS: Automatically changed to For Renewal')
