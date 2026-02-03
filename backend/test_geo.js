const GeoService = require('./services/geoService');

async function runTests() {
  console.log('Initializing GeoService...');
  const geo = new GeoService(); // No API key -> Uses Mocks

  console.log('\n--- Test 1: Valid Input (Mock Success) ---');
  // Has 'school' (mock trigger) and numbers (validation trigger)
  const result1 = await geo.resolveLocation('Saint Francis School', 'Block 5, Lot 2, Santa Rosa Estate, Cabuyao');
  console.log('Result:', JSON.stringify(result1, null, 2));

  console.log('\n--- Test 2: Valid Format but Broad Location (Mock Low Confidence) ---');
  // No 'school' in name (mock trigger for bad result), but has numbers (validation pass)
  // We simulate a case where the user inputs something that looks like an address but resolves to a generic area
  const result2 = await geo.resolveLocation('Generic Office', 'Highway 54, Cabuyao');
  console.log('Result:', JSON.stringify(result2, null, 2));

  console.log('\n--- Test 3: Invalid Address (Validation Error) ---');
  const result3 = await geo.resolveLocation('School Name', 'Cabuyao'); // Too short, no numbers
  console.log('Result:', JSON.stringify(result3, null, 2));

  console.log('\n--- Test 4: Empty Address ---');
  const result4 = await geo.resolveLocation('School Name', '');
  console.log('Result:', JSON.stringify(result4, null, 2));
}

runTests();
