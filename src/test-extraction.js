
import { extractPermitDetails, extractSchoolInfoFromText } from './utils/permitParser.js'

// Mock data
const mockPermitText1 = `
REPUBLIC OF THE PHILIPPINES
DEPARTMENT OF EDUCATION
REGION IV-A CALABARZON

GOVERNMENT PERMIT (SHS) No. SHS-123 s. 2024
Pursuant to the provisions of Republic Act No. 9155...
The ST. MARY'S ACADEMY located at 123 Rizal St., Calamba City is hereby granted...
to operate the Senior High School Program...
Strands: STEM, ABM
This permit shall be valid for School Year 2024-2025.
`

const mockPermitText2 = `
Department of Education
Region 4A

Government Recognition No. 005 s. 2023
Granted to
CODE SCHOOL INC.
(School)
situated at Brgy. 1, Santa Rosa, Laguna
for the Elementary Course (Grades 1-6)
Effective School Year 2023-2024
`

const mockPermitText3 = `
Partial text...
DepEd Permit No. E-099 s. 2025
...
Address: Poblacion, Biñan City
`

const mockPermitText4 = `
REPUBLIC OF THE PHILIPPINES
DEPARTMENT OF EDUCATION
REGION IV-A CALABARZON

GOVERNMENT PERMIT (R-Renewal)
SHS-062 s. 2018

AGUSTINIAN SCHOOL OF CABUYAO LAGUNA, INC.
60 Banay-Banay, Cabuyao City
(Complete Address)

Track                  Strand/Specialization
Academic               Science, Technology, Engineering and Mathematics (STEM)

This permit shall be valid for School Year 2018-2019.
`

console.log('--- TEST 1: Standard GP ---')
const r1 = extractPermitDetails(mockPermitText1)
const i1 = extractSchoolInfoFromText(mockPermitText1)
console.log('Permits:', JSON.stringify(r1, null, 2))
console.log('Info:', JSON.stringify(i1, null, 2))

console.log('\n--- TEST 2: Recognition ---')
const r2 = extractPermitDetails(mockPermitText2)
const i2 = extractSchoolInfoFromText(mockPermitText2)
console.log('Permits:', JSON.stringify(r2, null, 2))
console.log('Info:', JSON.stringify(i2, null, 2))

console.log('\n--- TEST 3: Partial ---')
const r3 = extractPermitDetails(mockPermitText3)
const i3 = extractSchoolInfoFromText(mockPermitText3)
console.log('Permits:', JSON.stringify(r3, null, 2))
console.log('Info:', JSON.stringify(i3, null, 2))

console.log('\n--- TEST 4: Noisy OCR ---')
const r4 = extractPermitDetails(mockPermitText4)
const i4 = extractSchoolInfoFromText(mockPermitText4)
console.log('Permits:', JSON.stringify(r4, null, 2))
console.log('Info:', JSON.stringify(i4, null, 2))
