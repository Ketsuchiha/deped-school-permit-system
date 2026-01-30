
const fetch = require('node-fetch');

const API_URL = 'http://localhost:3000/api';

async function test() {
  try {
    console.log('--- Starting Test ---');

    // 1. Create School
    const schoolRes = await fetch(`${API_URL}/schools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-school-' + Date.now(),
        name: 'Test School Trash',
        type: 'Private',
        address: '123 Test St'
      })
    });
    const school = await schoolRes.json();
    console.log('Created School:', school.id);

    // 2. Create Permit
    const permitRes = await fetch(`${API_URL}/permits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-permit-' + Date.now(),
        schoolId: school.id,
        levels: JSON.stringify(['Elementary']),
        schoolYear: '2024-2025',
        permitNumber: 'E-123',
        extractedText: ''
      })
    });
    const permit = await permitRes.json();
    console.log('Created Permit:', permit.id);

    // 3. Delete School
    const delRes = await fetch(`${API_URL}/schools/${school.id}`, {
      method: 'DELETE'
    });
    console.log('Delete School Status:', delRes.status);

    // 4. Check Trash
    const trashRes = await fetch(`${API_URL}/trash`);
    const trash = await trashRes.json();
    
    const foundSchool = trash.schools.find(s => s.id === school.id);
    const foundPermit = trash.permits.find(p => p.id === permit.id);
    
    console.log('Found School in Trash:', !!foundSchool);
    console.log('Found Permit in Trash:', !!foundPermit);
    
    if (foundSchool) console.log('School DeletedAt:', foundSchool.deletedAt);
    if (foundPermit) console.log('Permit DeletedAt:', foundPermit.deletedAt);

    if (!foundSchool || !foundPermit) {
      console.error('FAILED: School or Permit not found in trash');
      return;
    }

    // 5. Restore School
    const restoreRes = await fetch(`${API_URL}/restore/school/${school.id}`, {
      method: 'POST'
    });
    console.log('Restore Status:', restoreRes.status);

    // 6. Check Active
    const schoolsRes = await fetch(`${API_URL}/schools`);
    const schools = await schoolsRes.json();
    const activeSchool = schools.find(s => s.id === school.id);
    
    const permitsRes = await fetch(`${API_URL}/permits`);
    const permits = await permitsRes.json();
    const activePermit = permits.find(p => p.id === permit.id);

    console.log('Active School Restored:', !!activeSchool);
    console.log('Active Permit Restored:', !!activePermit);

    if (!activeSchool || !activePermit) {
        console.error('FAILED: School or Permit not restored');
    } else {
        console.log('SUCCESS: Full cycle test passed');
    }

    // Clean up (Hard Delete)
    // We can't hard delete active items via API (only trash), so we soft delete then hard delete
    await fetch(`${API_URL}/schools/${school.id}`, { method: 'DELETE' });
    await fetch(`${API_URL}/trash/school/${school.id}`, { method: 'DELETE' });
    console.log('Cleanup done');

  } catch (err) {
    console.error('Test Error:', err);
  }
}

test();
