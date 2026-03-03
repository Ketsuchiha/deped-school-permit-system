
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

// Layout similar to Citi Global College permit where "(School)" appears
// and the address is on the next line with numbers and street name.
const mockPermitText5 = `
REPUBLIC OF THE PHILIPPINES
DEPARTMENT OF EDUCATION
REGION IV-A CALABARZON

GOVERNMENT PERMIT (SHS) No. SHS-999 s. 2024

2001) and Republic Act No. 10533 (Enhanced Basic Education Act of 2013) ...

CITI GLOBAL COLLEGE INC.
(School)
4 (School) 5 #13, P. Rizal St., Poblacion Dos, Cabuyao City

This permit shall be valid for School Year 2024-2025.
`

// Permit where "No. SHS-777" and "School Year 2024-2025" are separated
const mockPermitText6 = `
REPUBLIC OF THE PHILIPPINES
DEPARTMENT OF EDUCATION
REGION IV-A CALABARZON

GOVERNMENT PERMIT (SHS)
No. SHS-777

This authority is granted to operate the Senior High School program.

The permit covers the following:
- Academic Track

School Year 2024-2025
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

console.log('\n--- TEST 5: Citi Global Style ---')
const r5 = extractPermitDetails(mockPermitText5)
const i5 = extractSchoolInfoFromText(mockPermitText5)
console.log('Permits:', JSON.stringify(r5, null, 2))
console.log('Info:', JSON.stringify(i5, null, 2))

console.log('\n--- TEST 6: No-only Permit with Separate SY ---')
const r6 = extractPermitDetails(mockPermitText6)
const i6 = extractSchoolInfoFromText(mockPermitText6)
console.log('Permits:', JSON.stringify(r6, null, 2))
console.log('Info:', JSON.stringify(i6, null, 2))
