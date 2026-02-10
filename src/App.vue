<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { Shield, Home, Building2, Search, Plus, Upload, Calendar, FileImage, Loader2, CheckCircle, XCircle, BarChart3, PieChart, LayoutDashboard, Pencil, Trash2, RotateCcw, RotateCw, Eye, Download, MapPin, History, MapPinOff, AlertTriangle } from 'lucide-vue-next'
import Tesseract from 'tesseract.js'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import CustomSelect from './components/CustomSelect.vue'
import { extractPermitDetails, extractSchoolInfoFromText, calculateConfidence } from './utils/permitParser.js'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Fix for Leaflet marker icons in Vue/Vite environment
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

GlobalWorkerOptions.workerSrc = workerSrc

// ─── View state ─────────────────────────────────────────────────────────────
const currentView = ref('admin') // 'search' | 'admin'

const API_URL = 'http://localhost:3000/api'

// const showSummary = ref(false) // Removed as per request

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
    // p.levels is an array from backend
    const pLevels = Array.isArray(p.levels) ? p.levels : []
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

// ─── Edit / Delete Logic ─────────────────────────────────────────────────────
const isEditingSchool = ref(false)
const isEditingPermit = ref(false)
const editSchoolForm = ref({})
const editPermitForm = ref({})
const editSchoolPermits = ref([])

async function refreshData() {
  try {
    const [schoolsRes, permitsRes] = await Promise.all([
      fetch(`${API_URL}/schools`),
      fetch(`${API_URL}/permits`)
    ])
    if (schoolsRes.ok) schools.value = await schoolsRes.json()
    if (permitsRes.ok) permits.value = await permitsRes.json()
    // Fetch trash count for dashboard
    fetchTrash()
  } catch (error) {
    console.error('Failed to fetch data:', error)
  }
}

// School CRUD
function openEditSchool(schoolId) {
  const s = schools.value.find(s => s.id === schoolId)
  if (!s) return
  editSchoolForm.value = { ...s }
  isEditingSchool.value = true
  editSchoolPermits.value = permits.value
    .filter(p => p.schoolId === schoolId)
    .map(p => ({
      id: p.id,
      schoolId: p.schoolId,
      levels: Array.isArray(p.levels) ? [...p.levels] : [],
      schoolYear: p.schoolYear || '',
      permitNumber: p.permitNumber || '',
      extractedText: p.extractedText || '',
      fileName: p.fileName || '',
      filePreviewUrl: p.filePreviewUrl || ''
    }))
}

async function deleteSchool(schoolId) {
  const confirmed = await confirmAction('Are you sure you want to delete this school? All its permits will also be deleted.')
  if (!confirmed) return
  
  try {
    const res = await fetch(`${API_URL}/schools/${schoolId}`, { method: 'DELETE' })
    if (res.ok) {
      showToast('School deleted successfully', 'success')
      if (selectedSchool.value?.schoolId === schoolId) {
        selectedSchool.value = null
      }
      refreshData()
      triggerTrashAnim()
    } else {
      throw new Error('Failed to delete')
    }
  } catch (err) {
    showToast('Failed to delete school', 'error')
  }
}

async function saveEditSchool() {
  if (!editSchoolForm.value.name) return
  
  try {
    const res = await fetch(`${API_URL}/schools/${editSchoolForm.value.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editSchoolForm.value)
    })
    
    if (res.ok) {
      for (const p of editSchoolPermits.value) {
        const formData = new FormData()
        formData.append('schoolId', p.schoolId)
        formData.append('levels', JSON.stringify(p.levels))
        formData.append('schoolYear', p.schoolYear)
        formData.append('permitNumber', p.permitNumber)
        formData.append('extractedText', p.extractedText || '')
        await fetch(`${API_URL}/permits/${p.id}`, {
          method: 'PUT',
          body: formData
        })
      }
      showToast('School and permits updated', 'success')
      isEditingSchool.value = false
      refreshData()
    } else {
      throw new Error('Failed to update')
    }
  } catch (err) {
    showToast('Failed to update school', 'error')
  }
}

// ─── Edit School Map Logic ──────────────────────────────────────────────────
const mapContainerEdit = ref(null)
const isGeocodingEdit = ref(false)
let mapInstanceEdit = null
let markerInstanceEdit = null
let debounceTimerEdit = null

function debounceGeocodeEdit() {
  if (debounceTimerEdit) clearTimeout(debounceTimerEdit)
  debounceTimerEdit = setTimeout(() => {
    geocodeEditAddress()
  }, 1000)
}

async function geocodeEditAddress() {
  const addr = editSchoolForm.value.address
  if (!addr || !addr.trim()) return

  isGeocodingEdit.value = true
  try {
    const res = await fetch(`${API_URL}/geocode?q=${encodeURIComponent(addr)}`)
    if (res.ok) {
      const data = await res.json()
      if (data && data.features && data.features.length > 0) {
        const [lng, lat] = data.features[0].geometry.coordinates
        // Just update map, don't reverse geocode back
        updateEditMapLocation(lat, lng, false) 
      } else {
        showToast('Location not found', 'error')
      }
    }
  } catch (err) {
    console.error('Geocoding failed:', err)
  } finally {
    isGeocodingEdit.value = false
  }
}

async function reverseGeocodeEdit(lat, lng) {
  isGeocodingEdit.value = true
  try {
     const res = await fetch(`${API_URL}/reverse-geocode?lat=${lat}&lon=${lng}`)
     const data = await res.json()
     if (data.status === 'SUCCESS' && data.address) {
        editSchoolForm.value.address = data.address
     }
  } catch (e) {
     console.error('Reverse geocode error:', e)
  } finally {
     isGeocodingEdit.value = false
  }
}

function updateEditMapLocation(lat, lng, triggerReverse = true) {
  editSchoolForm.value.latitude = lat
  editSchoolForm.value.longitude = lng
  
  if (mapInstanceEdit) {
    mapInstanceEdit.setView([lat, lng], 16)
    
    if (markerInstanceEdit) markerInstanceEdit.remove()
    markerInstanceEdit = L.marker([lat, lng], { draggable: true }).addTo(mapInstanceEdit)
    
    markerInstanceEdit.on('dragend', async (e) => {
      const { lat, lng } = e.target.getLatLng()
      editSchoolForm.value.latitude = lat
      editSchoolForm.value.longitude = lng
      await reverseGeocodeEdit(lat, lng)
    })
  }

  if (triggerReverse) {
     reverseGeocodeEdit(lat, lng)
  }
}

async function initEditMap() {
  await nextTick()
  if (!mapContainerEdit.value) return
  
  // Clean up existing map
  if (mapInstanceEdit) {
    mapInstanceEdit.remove()
    mapInstanceEdit = null
  }

  // Default coordinates (Cabuyao or existing)
  const lat = editSchoolForm.value.latitude || 14.277
  const lng = editSchoolForm.value.longitude || 121.123
  const zoom = editSchoolForm.value.latitude ? 16 : 13

  mapInstanceEdit = L.map(mapContainerEdit.value).setView([lat, lng], zoom)
  
  L.tileLayer(`${API_URL}/maps/proxy/{z}/{x}/{y}`, {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(mapInstanceEdit)

  // Add marker if coordinates exist
  if (editSchoolForm.value.latitude && editSchoolForm.value.longitude) {
    markerInstanceEdit = L.marker([lat, lng], { draggable: true }).addTo(mapInstanceEdit)
    
    markerInstanceEdit.on('dragend', async (e) => {
      const { lat, lng } = e.target.getLatLng()
      editSchoolForm.value.latitude = lat
      editSchoolForm.value.longitude = lng
      await reverseGeocodeEdit(lat, lng)
    })
  }

  // Map click to set location
  mapInstanceEdit.on('click', (e) => {
    const { lat, lng } = e.latlng
    // Trigger reverse geocode on click
    updateEditMapLocation(lat, lng, true)
  })
}

watch(isEditingSchool, (val) => {
  if (val) {
    initEditMap()
  } else {
    if (mapInstanceEdit) {
      mapInstanceEdit.remove()
      mapInstanceEdit = null
    }
  }
})

// Permit CRUD
function openEditPermit(permit) {
  editPermitForm.value = { 
    ...permit,
    // Ensure levels is array
    levels: Array.isArray(permit.levels) ? permit.levels : [],
    // For file upload
    file: null,
    fileName: permit.fileName || '',
    filePreviewUrl: permit.filePreviewUrl
  }
  isEditingPermit.value = true
}

async function deletePermit(permitId) {
  const confirmed = await confirmAction('Are you sure you want to delete this permit?')
  if (!confirmed) return
  
  try {
    const res = await fetch(`${API_URL}/permits/${permitId}`, { method: 'DELETE' })
    if (res.ok) {
      showToast('Permit deleted successfully', 'success')
      refreshData()
      triggerTrashAnim()
    } else {
      throw new Error('Failed to delete')
    }
  } catch (err) {
    showToast('Failed to delete permit', 'error')
  }
}

async function saveEditPermit() {
  const formData = new FormData()
  formData.append('schoolId', editPermitForm.value.schoolId)
  formData.append('levels', JSON.stringify(editPermitForm.value.levels))
  formData.append('schoolYear', editPermitForm.value.schoolYear)
  formData.append('permitNumber', editPermitForm.value.permitNumber)
  formData.append('extractedText', editPermitForm.value.extractedText || '')
  
  if (editPermitForm.value.file) {
    formData.append('file', editPermitForm.value.file)
  }
  
  try {
    const res = await fetch(`${API_URL}/permits/${editPermitForm.value.id}`, {
      method: 'PUT',
      body: formData
    })
    
    if (res.ok) {
      showToast('Permit updated successfully', 'success')
      isEditingPermit.value = false
      refreshData()
    } else {
      throw new Error('Failed to update')
    }
  } catch (err) {
    showToast('Failed to update permit', 'error')
  }
}

function onEditPermitFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  editPermitForm.value.file = file
  editPermitForm.value.fileName = file.name
}

function toggleEditPermitLevel(value) {
  const i = editPermitForm.value.levels.indexOf(value)
  if (i >= 0) editPermitForm.value.levels.splice(i, 1)
  else editPermitForm.value.levels.push(value)
}

// ─── Create New School ──────────────────────────────────────────────────────
const schoolForm = ref({
  name: '',
  type: 'Private', // Default to Private
  address: '',
  fileName: '',
  file: null, // For OCR upload
  filePreviewUrl: null,
  ocrLoading: false,
  ocrConfidence: 100,
  ocrErrors: [],
  // Combined Flow Fields
  levels: [],
  schoolYear: '',
  permitNumber: '',
  strands: [],
  extractedText: '',
  permits: [{ permitNumber: '', schoolYear: '', levels: [], strands: [] }]
})
const schoolFormErrors = ref({})

// Strict Address Input Validation
function sanitizeAddressString(input) {
  if (!input) return ''
  // Allow only letters (A-Z, a-z) and space
  // No numbers or special characters allowed
  return input.replace(/[^a-zA-Z\s]/g, '')
}

function sanitizeAddressInput(e) {
  const input = e.target.value
  const sanitized = sanitizeAddressString(input)
  
  // Update if changed
  if (input !== sanitized) {
    schoolForm.value.address = sanitized
    // Force DOM update to reflect sanitized value immediately
    e.target.value = sanitized
  }
}

// ─── Leaflet Map Logic ────────────────────────────────────────────────────────
const mapContainer = ref(null)
const mapInstance = ref(null)
const mapMarker = ref(null)
const isGeocoding = ref(false)
const geocodeError = ref('')
let debounceTimer = null

function initMap() {
  if (!mapContainer.value || mapInstance.value) return
  
  // Default: Calamba/Cabuyao area (approximate center) or Philippines
  // Cabuyao Coordinates: 14.277, 121.123
  mapInstance.value = L.map(mapContainer.value).setView([14.277, 121.123], 13)
  
  // Use local proxy to bypass client-side blocking of OSM tiles
  // Endpoint changed to /maps/proxy to avoid ad-blocker keywords
  const tiles = L.tileLayer(`${API_URL}/maps/proxy/{z}/{x}/{y}`, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  })
  
  tiles.on('tileerror', (error) => {
    console.warn('Map tile failed to load:', error)
  })
  
  tiles.addTo(mapInstance.value)

  // Manual Pinning with Reverse Geocoding
  mapInstance.value.on('click', async (e) => {
     const { lat, lng } = e.latlng
     await handleManualPin(lat, lng)
  })
}

async function handleManualPin(lat, lng) {
  // 1. Update Marker immediately for responsiveness
  if (mapMarker.value) {
      mapMarker.value.setLatLng([lat, lng])
  } else {
      mapMarker.value = L.marker([lat, lng], { draggable: true }).addTo(mapInstance.value)
      
      // Allow dragging the marker to refine position
      mapMarker.value.on('dragend', async (event) => {
        const pos = event.target.getLatLng()
        await handleManualPin(pos.lat, pos.lng)
      })
  }
  
  // 2. Update Form Coordinates
  schoolForm.value.latitude = lat
  schoolForm.value.longitude = lng
  
  // 3. Reverse Geocode (Get Address from Pin)
  isGeocoding.value = true
  geocodeError.value = ''
  
  try {
     const res = await fetch(`${API_URL}/reverse-geocode?lat=${lat}&lon=${lng}`)
     const data = await res.json()
     
     if (data.status === 'SUCCESS' && data.address) {
        // Update the address input
        schoolForm.value.address = data.address
     }
  } catch (e) {
     console.error('Reverse geocode error:', e)
     // Don't show error to user as this is an enhancement, not a critical failure
  } finally {
     isGeocoding.value = false
  }
}

async function updateMapFromAddress() {
  const address = schoolForm.value.address
  if (!address || address.length < 5) return

  isGeocoding.value = true
  geocodeError.value = ''

  try {
    const res = await fetch(`${API_URL}/geocode?address=${encodeURIComponent(address)}&name=${encodeURIComponent(schoolForm.value.name)}`)
    const data = await res.json()

    if (data.status === 'SUCCESS' && data.latitude && data.longitude) {
      const lat = parseFloat(data.latitude)
      const lng = parseFloat(data.longitude)
      
      if (mapMarker.value) {
          mapMarker.value.setLatLng([lat, lng])
      } else {
          mapMarker.value = L.marker([lat, lng]).addTo(mapInstance.value)
      }
      
      mapInstance.value.setView([lat, lng], 16)
      
      // Sync form with geocoded result
      schoolForm.value.latitude = lat
      schoolForm.value.longitude = lng
    } else {
      // Don't remove marker immediately if user is just typing, but maybe warn?
      // Actually requirement says: "If geocoding fails, do not place a marker; Display a clear error"
      geocodeError.value = 'Address not found on map'
      if (mapMarker.value) {
        mapInstance.value.removeLayer(mapMarker.value)
        mapMarker.value = null
        schoolForm.value.latitude = null
        schoolForm.value.longitude = null
      }
    }
  } catch (e) {
    console.error('Map update error:', e)
    geocodeError.value = 'Failed to load map data'
  } finally {
    isGeocoding.value = false
  }
}

// Watch address change with debounce
watch(() => schoolForm.value.address, (newVal) => {
  if (!newVal) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    updateMapFromAddress()
  }, 1000)
})

// Watch view change to init map when Registration tab opens
watch(currentView, async (newVal) => {
  if (newVal === 'registration') {
    // Reset map instance if it exists but container is new (should rely on cleanup, but just in case)
    if (mapInstance.value) {
       mapInstance.value.remove()
       mapInstance.value = null
       mapMarker.value = null
    }

    await nextTick()
    // Give a slight delay for transition/rendering
    setTimeout(() => {
       initMap()
       // If address is already pre-filled (e.g. from OCR), update map
       if (schoolForm.value.address) {
          updateMapFromAddress()
       }
    }, 300)
  } else {
    // Cleanup map when leaving registration view
    if (mapInstance.value) {
       mapInstance.value.remove()
       mapInstance.value = null
       mapMarker.value = null
    }
  }
})

onMounted(async () => {
  await refreshData()
})

const searchQuery = ref('')
const rawSearchInput = ref('')
const isSearching = ref(false)
let searchTimeout = null
const searchError = ref('')

function isValidSearchInput(str) {
  if (!str) return true
  if (str.length > 100) return false
  // Allow letters, numbers, spaces, period, comma, apostrophe, hyphen, ampersand
  return /^[a-zA-Z0-9\s.,'&-]+$/.test(str)
}

watch(rawSearchInput, (newVal) => {
  isSearching.value = true
  if (searchTimeout) clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    const trimmed = newVal.trim()
    if (!isValidSearchInput(trimmed)) {
      searchError.value = 'Invalid search. Use letters, numbers, spaces, period or comma.'
      isSearching.value = false
      return
    }
    searchError.value = ''
    searchQuery.value = trimmed
    isSearching.value = false
  }, 500)
})

// Confirmation state handling is unified at the bottom of the script

// ─── Map Logic for Admin View ──────────────────────────────────────────────────────────────
const selectedSchool = ref(null)

const mapContainerView = ref(null)
let mapInstanceView = null
let markerInstanceView = null

// New Map for Details Modal
const mapContainerDetails = ref(null)
let mapInstanceDetails = null
let markerInstanceDetails = null

// Watch selected school to update maps
watch(selectedSchool, async (school) => {
  if (!school) {
     if (mapInstanceView) {
        mapInstanceView.remove()
        mapInstanceView = null
     }
     if (mapInstanceDetails) {
        mapInstanceDetails.remove()
        mapInstanceDetails = null
     }
     return
  }
  
  await nextTick()
  
  // 1. Update Main View Map (Sticky)
  if (mapContainerView.value) {
      const lat = school.latitude
      const lng = school.longitude
      
      if (lat && lng) {
         if (!mapInstanceView) {
            mapInstanceView = L.map(mapContainerView.value).setView([lat, lng], 15)
            L.tileLayer(`${API_URL}/maps/proxy/{z}/{x}/{y}`, {
               maxZoom: 19,
               attribution: '© OpenStreetMap'
            }).addTo(mapInstanceView)
         } else {
            mapInstanceView.setView([lat, lng], 15)
            mapInstanceView.invalidateSize()
         }
         
         if (markerInstanceView) markerInstanceView.remove()
         markerInstanceView = L.marker([lat, lng], { draggable: false }).addTo(mapInstanceView)
      }
  }

  // 2. Update Details Modal Map
  if (mapContainerDetails.value) {
      const lat = school.latitude
      const lng = school.longitude
      
      if (lat && lng) {
         if (!mapInstanceDetails) {
            mapInstanceDetails = L.map(mapContainerDetails.value).setView([lat, lng], 16)
            L.tileLayer(`${API_URL}/maps/proxy/{z}/{x}/{y}`, {
               maxZoom: 19,
               attribution: '© OpenStreetMap'
            }).addTo(mapInstanceDetails)
         } else {
            mapInstanceDetails.setView([lat, lng], 16)
            mapInstanceDetails.invalidateSize()
         }
         
         if (markerInstanceDetails) markerInstanceDetails.remove()
         markerInstanceDetails = L.marker([lat, lng], { draggable: false }).addTo(mapInstanceDetails)
      } else {
         // Default view if no coords
         if (!mapInstanceDetails) {
             mapInstanceDetails = L.map(mapContainerDetails.value).setView([14.278, 121.122], 13)
             L.tileLayer(`${API_URL}/maps/proxy/{z}/{x}/{y}`, { maxZoom: 19 }).addTo(mapInstanceDetails)
         }
      }
  }
})

function selectSchool(id) {
  const group = searchResults.value.find(g => g.schoolId === id)
  if (group) {
    selectedSchool.value = group
    // isMapModalOpen.value = true // Disable separate map modal to show combined view
    showDetailsModal.value = false
  }
}

// ─── Map Modal Logic ─────────────────────────────────────────────────────────
const isMapModalOpen = ref(false)
const showDetailsModal = ref(false)
const mapModalContainer = ref(null)
let mapModalInstance = null

function closeMapModal() {
  isMapModalOpen.value = false
  if (mapModalInstance) {
    mapModalInstance.remove()
    mapModalInstance = null
  }
}

function openDetailsFromMap() {
  isMapModalOpen.value = false
  showDetailsModal.value = true
}

watch(isMapModalOpen, async (isOpen) => {
  if (isOpen && selectedSchool.value) {
    await nextTick()
    initModalMap()
  }
})

function initModalMap() {
  if (!mapModalContainer.value || !selectedSchool.value) return
  
  if (mapModalInstance) {
    mapModalInstance.remove()
    mapModalInstance = null
  }

  const school = selectedSchool.value
  const lat = school.latitude || 14.2471423
  const lng = school.longitude || 121.1366715

  mapModalInstance = L.map(mapModalContainer.value).setView([lat, lng], 16)
  
  L.tileLayer(`${API_URL}/maps/proxy/{z}/{x}/{y}`, {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(mapModalInstance)

  L.marker([lat, lng])
    .addTo(mapModalInstance)
    .bindPopup(`
      <div class="text-center p-2">
        <h3 class="font-bold text-slate-800 mb-1">${school.schoolName}</h3>
        <p class="text-xs text-slate-500 mb-2">${school.schoolAddress}</p>
        <button id="view-details-btn" class="text-xs bg-sky-600 text-white px-3 py-1.5 rounded-lg hover:bg-sky-700 transition-colors w-full">
          View Details
        </button>
      </div>
    `)
    .openPopup()

  mapModalInstance.on('popupopen', () => {
    const btn = document.getElementById('view-details-btn')
    if (btn) {
      btn.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        openDetailsFromMap()
      }
    }
  })
}

// ─── Level options for Upload Permit ─────────────────────────────────────────
const levelOptions = [
  { value: 'Kindergarten', label: 'Kindergarten' },
  { value: 'Elementary', label: 'Elementary' },
  { value: 'Junior High School', label: 'Junior High School' },
  { value: 'Senior High School', label: 'Senior High School' },
]

// ─── Trash Bin Logic ─────────────────────────────────────────────────────────
const trashSchools = ref([])
const trashPermits = ref([])
const trashLoading = ref(false)
const trashAnimating = ref(false)

const unifiedTrash = computed(() => {
  const schoolIds = new Set(trashSchools.value.map(s => s.id))
  
  const displaySchools = trashSchools.value.map(s => ({
    id: s.id,
    type: 'school',
    title: s.name,
    subtitle: s.address,
    deletedAt: s.deletedAt,
    badgeColor: 'bg-purple-100 text-purple-700',
    icon: 'School' // We'll render icon dynamically if needed, or just use badge
  }))
  
  const displayPermits = trashPermits.value
    .filter(p => !schoolIds.has(p.schoolId))
    .map(p => ({
      id: p.id,
      type: 'permit',
      title: getSchoolName(p.schoolId),
      subtitle: `Permit No: ${p.permitNumber} (SY ${p.schoolYear})`,
      deletedAt: p.deletedAt,
      badgeColor: 'bg-blue-100 text-blue-700'
    }))
    
  return [...displaySchools, ...displayPermits].sort((a, b) => 
    new Date(b.deletedAt) - new Date(a.deletedAt)
  )
})

const trashCount = computed(() => unifiedTrash.value.length)

watch(currentView, (newVal) => {
  if (newVal === 'trash') fetchTrash()
})

async function fetchTrash() {
  trashLoading.value = true
  try {
    const res = await fetch(`${API_URL}/trash`)
    if (res.ok) {
      const data = await res.json()
      trashSchools.value = data.schools || []
      trashPermits.value = data.permits || []
    }
  } catch (err) {
    console.error('Failed to fetch trash:', err)
  } finally {
    trashLoading.value = false
  }
}

function triggerTrashAnim() {
  trashAnimating.value = true
  setTimeout(() => {
    trashAnimating.value = false
  }, 1000)
}

function getSchoolName(schoolId) {
  // Check active schools
  const active = schools.value.find(s => s.id === schoolId)
  if (active) return active.name
  // Check trash schools
  const trash = trashSchools.value.find(s => s.id === schoolId)
  if (trash) return trash.name + ' (Deleted)'
  return 'Unknown School'
}

function getSchoolAddress(schoolId) {
  const active = schools.value.find(s => s.id === schoolId)
  if (active) return active.address
  const trash = trashSchools.value.find(s => s.id === schoolId)
  if (trash) return trash.address
  return ''
}

async function restoreItem(type, id) {
  try {
    const res = await fetch(`${API_URL}/restore/${type}/${id}`, { method: 'POST' })
    if (res.ok) {
      showToast('Item restored successfully', 'success')
      fetchTrash()
      refreshData() // Refresh active data
    } else {
      throw new Error('Failed to restore')
    }
  } catch (err) {
    showToast('Failed to restore item', 'error')
  }
}

async function deleteForever(type, id) {
  const confirmed = await confirmAction('Are you sure? This action cannot be undone.')
  if (!confirmed) return

  try {
    const res = await fetch(`${API_URL}/trash/${type}/${id}`, { method: 'DELETE' })
    if (res.ok) {
      showToast('Item permanently deleted', 'success')
      fetchTrash()
    } else {
      throw new Error('Failed to delete')
    }
  } catch (err) {
    showToast('Failed to delete item', 'error')
  }
}

const createTab = ref('school') // 'school' | 'homeschool'

// ─── Image Preprocessing Helpers ───
function applyImageEnhancement(ctx, width, height) {
  // 1. Get image data
  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data
  
  // 2. Grayscale & Contrast
  const contrast = 1.5 // 50% increase
  const intercept = 128 * (1 - contrast)
  
  // Create a copy for noise reduction (reading from original/processed, writing to buffer)
  // We'll apply grayscale/contrast first in place, then do noise reduction
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114
    let newGray = gray * contrast + intercept
    newGray = Math.max(0, Math.min(255, newGray))
    
    data[i] = newGray
    data[i+1] = newGray
    data[i+2] = newGray
  }

  // 3. Noise Reduction (Median Filter 3x3) - Helps remove salt-and-pepper noise
  // We need a copy of the data to read neighbors from
  const originalData = new Uint8ClampedArray(data)
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4
      
      // Collect 3x3 window
      const window = []
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const nIdx = ((y + ky) * width + (x + kx)) * 4
          window.push(originalData[nIdx]) // Only need R channel since it's grayscale
        }
      }
      
      // Sort and pick median
      window.sort((a, b) => a - b)
      const median = window[4]
      
      data[idx] = median
      data[idx+1] = median
      data[idx+2] = median
      // Alpha remains unchanged
    }
  }

  ctx.putImageData(imageData, 0, 0)
}

async function preprocessImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      canvas.width = img.width
      canvas.height = img.height
      ctx.drawImage(img, 0, 0)
      
      applyImageEnhancement(ctx, canvas.width, canvas.height)
      
      canvas.toBlob((blob) => resolve(blob), file.type)
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}

async function rotateBlob(blob, angle) {
  const img = new Image()
  const url = URL.createObjectURL(blob)
  img.src = url
  await new Promise(r => img.onload = r)
  URL.revokeObjectURL(url)
  
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  
  // Swap dimensions for 90/270 degrees
  if (Math.abs(angle) % 180 === 90) {
    canvas.width = img.height
    canvas.height = img.width
  } else {
    canvas.width = img.width
    canvas.height = img.height
  }
  
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(angle * Math.PI / 180)
  ctx.drawImage(img, -img.width / 2, -img.height / 2)
  
  return new Promise(resolve => canvas.toBlob(resolve, blob.type))
}

async function rotateImage(direction) {
  if (!schoolForm.value.file || !schoolForm.value.file.type.startsWith('image/')) return
  
  try {
    const blob = await rotateBlob(schoolForm.value.file, direction)
    const newFile = new File([blob], schoolForm.value.fileName, { type: schoolForm.value.file.type })
    processSchoolFile(newFile)
  } catch (err) {
    console.error('Rotation failed:', err)
  }
}

async function detectOrientation(imageBlob) {
  try {
    // Use OSD mode (psm: 0) to detect orientation
    const { data } = await Tesseract.recognize(imageBlob, 'osd', {
      logger: m => {} 
    })
    
    // Tesseract OSD returns orientation_degrees (angle to rotate to be upright)
    // and confidence.
    if (data.confidence > 80 && data.orientation_degrees !== 0) {
       return data.orientation_degrees
    }
    return 0
  } catch (e) {
    console.warn('OSD failed, skipping auto-rotation', e)
    return 0
  }
}

async function processSchoolFile(file) {
  if (schoolForm.value.filePreviewUrl) URL.revokeObjectURL(schoolForm.value.filePreviewUrl)
  schoolForm.value.file = file
  schoolForm.value.filePreviewUrl = URL.createObjectURL(file)
  schoolForm.value.fileName = file.name
  schoolForm.value.ocrLoading = true
  
  try {
    let text = ''
    if (file.type.startsWith('image/')) {
      let processedBlob = await preprocessImage(file)
      
      // Auto-Orientation Detection
      const angle = await detectOrientation(processedBlob)
      if (angle !== 0) {
         console.log(`Auto-rotating image by ${angle} degrees`)
         processedBlob = await rotateBlob(processedBlob, angle)
         // Update preview with rotated image
         URL.revokeObjectURL(schoolForm.value.filePreviewUrl)
         schoolForm.value.filePreviewUrl = URL.createObjectURL(processedBlob)
         // Update stored file so manual rotation works on the new orientation
         schoolForm.value.file = new File([processedBlob], file.name, { type: file.type })
      }
      
      const { data } = await Tesseract.recognize(processedBlob, 'eng+fil')
      text = data.text
    } else if (file.type === 'application/pdf') {
       // Robust PDF text extract
       const buf = await file.arrayBuffer()
       const pdf = await getDocument({ data: buf }).promise
       
       const maxPages = Math.min(pdf.numPages, 50) 
       for (let i = 1; i <= maxPages; i++) {
         const page = await pdf.getPage(i)
         const content = await page.getTextContent()
         let pageText = content.items.map((it) => ('str' in it ? it.str : '')).join(' ')
         
         pageText = ` --- PAGE ${i} --- \n ${pageText} \n`
         
         if (pageText.replace(/\s/g, '').length < 50) {
            try {
              const viewport = page.getViewport({ scale: 2.0 })
              const canvas = document.createElement('canvas')
              const context = canvas.getContext('2d')
              canvas.height = viewport.height
              canvas.width = viewport.width
              await page.render({ canvasContext: context, viewport: viewport }).promise
              
              applyImageEnhancement(context, viewport.width, viewport.height)
              
              const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
              const { data } = await Tesseract.recognize(blob, 'eng+fil')
              pageText = data.text
            } catch (ocrErr) {
              console.error('Page OCR failed:', ocrErr)
            }
         }
         text += pageText + ' '
       }
    }
    
    schoolForm.value.extractedText = text

    // ─── Centralized Extraction ───
    const { schoolName, address, confidence, errors } = extractSchoolInfoFromText(text)
    schoolForm.value.ocrConfidence = confidence !== undefined ? confidence : 100
    schoolForm.value.ocrErrors = errors || []
    
    // Log OCR Health
    if (confidence < 70 || (errors && errors.length > 0)) {
       fetch(`${API_URL}/logs/ocr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
             errorCode: errors.join(', ') || 'LOW_CONFIDENCE',
             confidence,
             fileName: file.name,
             details: `Name: ${schoolName}, Addr: ${address}`
          })
       }).catch(e => console.error('Failed to log OCR health', e))
    }

    if (schoolName) schoolForm.value.name = schoolName
    if (address) {
       schoolForm.value.address = sanitizeAddressString(address)
    }

    // Fallback: Use Filename as School Name if still empty and filename looks like a name
    if (!schoolForm.value.name && file.name) {
       const nameFromExt = file.name.replace(/\.(pdf|jpg|jpeg|png)$/i, '')
       if (!/permit|recognition|gov|deped/i.test(nameFromExt) && nameFromExt.length > 5) {
          schoolForm.value.name = nameFromExt
       }
    }

    // ─── Unified Flow: Extract Multiple Permits ───
    const extractedPermits = extractPermitDetails(text)
    if (extractedPermits && extractedPermits.length > 0) {
      schoolForm.value.permits = extractedPermits.map(p => ({
         permitNumber: p.permitNumber,
         schoolYear: p.schoolYear,
         levels: p.levels,
         strands: p.strands || [],
      }))
      
      showToast(`Detected ${extractedPermits.length} permit(s). Auto-filled details.`, 'success')
    } else {
      if (schoolForm.value.permits.length === 0) {
         schoolForm.value.permits.push({
            permitNumber: '',
            schoolYear: '',
            levels: [],
            strands: []
         })
      }
      showToast('School info scanned. No permits detected.', 'info')
    }

  } catch (err) {
    console.error('File Processing Error:', err)
    let msg = 'Failed to scan file'
    if (err.message) msg += `: ${err.message}`
    showToast(msg, 'error')
  } finally {
    schoolForm.value.ocrLoading = false
  }
}

function verifyScan() {
  schoolForm.value.ocrConfidence = 100
  schoolForm.value.ocrErrors = []
  showToast('Marked as verified', 'success')
}

async function onSchoolFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  processSchoolFile(file)
}

function setCreateTab(tab) {
  createTab.value = tab
  schoolFormErrors.value = {}
  
  const commonFields = {
    name: '',
    address: '',
    latitude: null,
    longitude: null,
    file: null,
    fileName: '',
    filePreviewUrl: null,
    ocrLoading: false,
    extractedText: '',
    permits: [] // Array of { permitNumber, schoolYear, levels, strands }
  }

  if (tab === 'homeschool') {
    schoolForm.value = { 
       ...commonFields, 
       type: 'Homeschooling',
       permits: [{ permitNumber: '', schoolYear: '', levels: [], strands: [] }]
    }
    setManageTab('application')
  } else {
    schoolForm.value = { 
       ...commonFields, 
       type: 'Private',
       permits: [{ permitNumber: '', schoolYear: '', levels: [], strands: [] }]
    }
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
    latitude: schoolForm.value.latitude,
    longitude: schoolForm.value.longitude
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
      
      // ─── Unified Flow: Create Multiple Permits ───
      let permitSuccessCount = 0
      
      if (schoolForm.value.permits && schoolForm.value.permits.length > 0) {
         for (const permit of schoolForm.value.permits) {
            // Only create if it has at least a permit number or levels
            if (!permit.permitNumber && permit.levels.length === 0) continue
            
            try {
              const formData = new FormData()
              formData.append('id', crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).substr(2, 9))
              formData.append('schoolId', savedSchool.id)
              formData.append('levels', JSON.stringify(permit.levels))
              formData.append('schoolYear', permit.schoolYear)
              formData.append('permitNumber', permit.permitNumber)
              formData.append('extractedText', schoolForm.value.extractedText || '')
              
              if (permit.levels.includes('Senior High School') && permit.strands?.length) {
                 formData.append('strands', JSON.stringify(permit.strands))
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
                 permitSuccessCount++
              }
            } catch (pErr) {
               console.error('Permit creation failed', pErr)
            }
         }
      }
      
      if (permitSuccessCount > 0) {
         showToast(`School and ${permitSuccessCount} permit(s) created successfully!`, 'success')
      } else {
         showToast('School created successfully!', 'success')
      }

      // Reset form, keep current type based on tab
      schoolForm.value = { 
        name: '', 
        type: createTab.value === 'homeschool' ? 'Homeschooling' : 'Private', 
        address: '', 
        latitude: null,
        longitude: null,
        extractedText: '',
        file: null,
        fileName: '',
        filePreviewUrl: null,
        ocrLoading: false,
        permits: [{ permitNumber: '', schoolYear: '', levels: [], strands: [] }]
      }
      
      // Clear map marker
      if (mapMarker.value) {
         mapInstance.value?.removeLayer(mapMarker.value)
         mapMarker.value = null
      }
      if (mapInstance.value) {
         mapInstance.value.setView([14.277, 121.123], 13)
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
function extractPermitDetails_UNUSED(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return []
  
  // 1. Pre-process: Normalize whitespace and fix common OCR typos in keywords
  let t = text.replace(/\s+/g, ' ').trim()
  
  // Fuzzy replacements for key terms
  const replacements = [
    { pattern: /G[o0]vern?ment\s+P[e3]rmit/gi, replacement: 'Government Permit' },
    { pattern: /G[o0]vern?ment\s+Rec[o0]gni[t7]ion/gi, replacement: 'Government Recognition' },
    { pattern: /DepEd\s+P[e3]rmit/gi, 'replacement': 'Government Permit' },
    { pattern: /Auth[o0]rity\s+to\s+Operate/gi, replacement: 'Authority to Operate' },
    { pattern: /Provi[s5]ional\s+P[e3]rmit/gi, replacement: 'Provisional Permit' },
    { pattern: /s\.\s*(\d{4})/gi, replacement: 's. $1' }, // Ensure space after s.
    { pattern: /series\s+of/gi, replacement: 's.' },
    { pattern: /dated/gi, replacement: 's.' } // Treat "dated" as "s." for parsing
  ]
  
  replacements.forEach(({ pattern, replacement }) => {
    t = t.replace(pattern, replacement)
  })
  
  console.log('Extracted Text (Normalized):', t)
  const permits = []

  // Helper: Detect Strands (Full names & Abbreviations)
  const detectStrands = (txt) => {
    const found = []
    
    // STEM
    if (/STEM|Science,? Technology,? Engineering,? (?:and|&) Mathematics|Science\s+and\s+Technology/i.test(txt)) {
       if (!found.includes('STEM')) found.push('STEM')
    }
    
    // ABM
    if (/ABM|Accountancy,? Business,? (?:and|&) Management|Business\s+and\s+Management/i.test(txt)) {
       if (!found.includes('ABM')) found.push('ABM')
    }
    
    // HUMSS
    if (/HUMSS|Humanities (?:and|&) Social Sciences|Humanities/i.test(txt)) {
       if (!found.includes('HUMSS')) found.push('HUMSS')
    }
    
    // GAS
    if (/GAS|General Academic/i.test(txt)) {
       if (!found.includes('GAS')) found.push('GAS')
    }
    
    // TVL & Specializations
    const tvlKeywords = [
       'TVL', 
       'Technical[- ]Vocational[- ]Livelihood',
       'Tech[- ]Voc',
       'ICT', 'Information and Communications Technology', 'Computer Systems Servicing', 'Programming', 'Animation',
       'Home Economics', 'HE', 'Cookery', 'Bread and Pastry', 'Food and Beverage', 'Housekeeping', 'Caregiving', 'Dressmaking', 'Tailoring', 'Wellness Massage',
       'Agri-Fishery', 'AFA', 'Agriculture', 'Fishery',
       'Industrial Arts', 'IA', 'Automotive', 'Welding', 'Electrical Installation', 'Electronics', 'Carpentry', 'Plumbing', 'Shielded Metal Arc'
    ]
    const tvlRegex = new RegExp(tvlKeywords.join('|'), 'i')
    if (tvlRegex.test(txt)) {
       if (!found.includes('TVL')) found.push('TVL')
    }
    
    // Sports
    if (/Sports/i.test(txt)) {
       if (!found.includes('Sports')) found.push('Sports')
    }
    
    // Arts and Design
    if (/Arts (?:and|&) Design|Design/i.test(txt)) {
       if (!found.includes('Arts and Design')) found.push('Arts and Design')
    }
    
    return found
  }
  
  // Helper: Clean Permit Number
  const cleanPermitNumber = (raw) => {
      // Remove trailing punctuation
      let clean = raw.replace(/[.,:;]+$/, '').trim()
      // Fix common char swaps in numbers (O -> 0, l/I -> 1) if mixed
      // Only apply if it looks like it should be alphanumeric (e.g., "SHS-O89" -> "SHS-089")
      if (/[A-Z]+-\w+/.test(clean)) {
          const parts = clean.split('-')
          if (parts.length > 1) {
              // Usually the second part is numeric
              parts[1] = parts[1].replace(/O/g, '0').replace(/[lI]/g, '1')
              clean = parts.join('-')
          }
      }
      return clean
  }

  // Strategy 1: Strong "Keyword ... No. ... s. Year" Pattern
  // Matches: "Government Permit (R-IVA) No. SHS-089 s. 2018"
  const strongRegex = /(?:Government\s+Permit|Government\s+Recognition|Authority\s+to\s+Operate|Provisional\s+Permit)(?:\s*\(.*?\))?[\s:.]+(?:No\.?|Number)?[\s:.]*([A-Z0-9\s-]+?)[\s,.]+(?:s\.)\s*(\d{4}(?:[-]\d{4})?)/gi
  
  let match
  while ((match = strongRegex.exec(t)) !== null) {
    let pNum = cleanPermitNumber(match[1])
    let sYear = match[2].trim()
    
    // Validation: Permit number shouldn't be too long or contain too many spaces
    if (pNum.length > 30 || (pNum.match(/\s/g) || []).length > 3) continue
    
    const levels = []
    let strands = []
    
    // Infer Level from Permit Number Prefix
    if (/^K[-]/i.test(pNum) || /Kindergarten/i.test(pNum)) levels.push('Kindergarten')
    else if (/^E[-]/i.test(pNum) || /Elementary/i.test(pNum)) levels.push('Elementary')
    else if (/^S[-]/i.test(pNum) || /^JHS[-]/i.test(pNum) || /Junior/i.test(pNum)) levels.push('Junior High School') 
    else if (/^SHS[-]/i.test(pNum) || /Senior/i.test(pNum)) levels.push('Senior High School')
    
    // Context fallback
    if (levels.length === 0) {
       const context = t.substring(Math.max(0, match.index - 800), match.index + 800)
       if (/Kindergarten/i.test(context)) levels.push('Kindergarten')
       if (/Elementary/i.test(context)) levels.push('Elementary')
       if (/Junior\s*High/i.test(context)) levels.push('Junior High School')
       if (/Senior\s*High/i.test(context)) levels.push('Senior High School')
    }

    if (levels.includes('Senior High School')) {
       strands = detectStrands(t.substring(Math.max(0, match.index - 500), match.index + 2000))
    }

    permits.push({
      permitNumber: pNum,
      schoolYear: sYear,
      levels: [...new Set(levels)],
      strands: strands
    })
  }

  // Strategy 2: Relaxed "No. ... s. Year" (fallback)
  // Only if no strong matches, or to catch additional ones
  // Must look like a structured ID (e.g., contains dashes or digits) to avoid false positives
  const looseRegex = /(?:No\.?|Number)[\s:.]*([A-Z0-9-]{3,20})[\s,.]+(?:s\.)\s*(\d{4}(?:[-]\d{4})?)/gi
  
  while ((match = looseRegex.exec(t)) !== null) {
      let pNum = cleanPermitNumber(match[1])
      const sYear = match[2].trim()
      
      // Skip if already found
      if (permits.some(p => p.permitNumber === pNum)) continue;

      // Basic validation for loose match
      // Must contain at least one digit or a hyphen to be considered a permit number
      if (!/[\d-]/.test(pNum)) continue;

      const levels = []
      // Check prefix
      if (/^K[-]/i.test(pNum)) levels.push('Kindergarten')
      else if (/^E[-]/i.test(pNum)) levels.push('Elementary')
      else if (/^S[-]/i.test(pNum) || /^JHS[-]/i.test(pNum)) levels.push('Junior High School') 
      else if (/^SHS[-]/i.test(pNum)) levels.push('Senior High School')
      
      if (levels.length === 0) {
          const context = t.substring(Math.max(0, match.index - 800), match.index + 800)
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

  // Deduplicate permits by number + year
  const uniquePermits = []
  const seen = new Set()
  permits.forEach(p => {
      // Normalize year for dedupe (2024 -> 2024-2025? Optional, keeping raw for now)
      const key = `${p.permitNumber}-${p.schoolYear}`
      if (!seen.has(key)) {
          seen.add(key)
          uniquePermits.push(p)
      }
  })

  return uniquePermits
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
      const processedBlob = await preprocessImage(file)
      const { data } = await Tesseract.recognize(processedBlob, 'eng')
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
             
             applyImageEnhancement(context, viewport.width, viewport.height)
             
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
  
  let endYear = null
  
  // Try to parse "YYYY-YYYY"
  const parts = schoolYear.split('-').map(p => parseInt(p.trim(), 10))
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    endYear = parts[1]
  } else {
    // Try single year "YYYY"
    const single = parseInt(schoolYear.trim(), 10)
    if (!isNaN(single)) {
      // If "2018", assume SY 2018-2019, so end year is 2019
      endYear = single + 1
    }
  }

  if (!endYear) {
    return { label: 'Invalid SY', color: 'gray' }
  }
  
  // Logic:
  // 1. Operating: Until July 31 of the End Year (Approx. End of School Year)
  // 2. For Renewal: For 1 year after expiration
  // 3. Closed: If not renewed after 1 year (expiration + 1 year)
  
  // Use July 31 as the standard end of School Year (adjusted for PH shift)
  const expirationDate = new Date(endYear, 6, 31) 
  const now = new Date()
  
  // Reset hours for accurate day calc
  now.setHours(0, 0, 0, 0)
  expirationDate.setHours(0, 0, 0, 0)
  
  const msPerDay = 24 * 60 * 60 * 1000
  const daysPast = Math.floor((now - expirationDate) / msPerDay)
  
  if (daysPast <= 0) {
    return { label: 'Operating', color: 'green' }
  } else if (daysPast <= 365) {
    // Within 1 year of expiration: For Renewal
    return { label: 'For Renewal', color: 'yellow' }
  } else {
    // Over 1 year past expiration: Closed
    return { label: 'Closed', color: 'red' }
  }
}

function getStatusBadgeClass(status) {
  if (!status) return 'bg-gray-50 text-gray-600 border-gray-200'
  if (status.includes('Operational')) return 'bg-green-50 text-green-700 border-green-200'
  if (status === 'For Renewal') return 'bg-yellow-50 text-yellow-700 border-yellow-200'
  if (status === 'Closed') return 'bg-red-50 text-red-700 border-red-200'
  return 'bg-gray-50 text-gray-600 border-gray-200'
}

function getOverallSchoolStatus(permits) {
  if (!permits || permits.length === 0) return { label: 'No Records', color: 'gray' }

  // Helper to get end year for sorting
  const getEndYear = (sy) => {
    if (!sy) return 0
    const parts = sy.split('-').map(p => parseInt(p.trim(), 10))
    if (parts.length === 2 && !isNaN(parts[1])) return parts[1]
    const single = parseInt(sy.trim(), 10)
    return !isNaN(single) ? single + 1 : 0
  }

  // Sort by end year descending to get the latest permit
  const sorted = [...permits].sort((a, b) => getEndYear(b.schoolYear) - getEndYear(a.schoolYear))
  
  // Return status of the latest permit
  return getStatus(sorted[0].schoolYear)
}



function getSchoolType(schoolId) {
  return schools.value.find((s) => s.id === schoolId)?.type ?? 'Private'
}

function openPreview(p) {
  previewPermit.value = p
}

function closePreview() {
  previewPermit.value = null
}

const isRenewingPermit = ref(false)

function openRenewPermit(schoolId) {
  resetPermitForm()
  permitForm.value.schoolId = schoolId
  isRenewingPermit.value = true
}

function downloadFile(permit) {
  const url = permit.filePreviewUrl || `${API_URL.replace('/api', '')}/uploads/${permit.fileName}`
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.download = permit.fileName || `permit-${permit.permitNumber || 'doc'}`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

function closeSchoolDetails() {
  selectedSchool.value = null
}

// ─── Public Search: filtered results ────────────────────────────────────────
const filterType = ref('All') // 'All' | 'Private' | 'Homeschooling'

// ─── Base grouping for cards (used by search and default list) ──────────────
const visibleSchoolLimit = ref(5)

const groupedResults = computed(() => {
  const type = filterType.value
  const grouped = {}
  permits.value.forEach(p => {
    if (!grouped[p.schoolId]) {
      const s = schools.value.find(sc => sc.id === p.schoolId)
      grouped[p.schoolId] = {
        schoolId: p.schoolId,
        schoolName: s ? s.name : 'Unknown',
        schoolAddress: s ? s.address : '',
        schoolType: s ? s.type : 'Private',
        status: s ? s.status : 'No Permits',
        latitude: s ? s.latitude : null,
        longitude: s ? s.longitude : null,
        permits: []
      }
    }
    grouped[p.schoolId].permits.push(p)
  })
  let results = Object.values(grouped)

  // Handle Duplicate Names (Branch Detection)
  const nameCounts = {}
  results.forEach(r => {
    const n = r.schoolName.trim().toLowerCase()
    nameCounts[n] = (nameCounts[n] || 0) + 1
  })

  results.forEach(r => {
    if (nameCounts[r.schoolName.trim().toLowerCase()] > 1) {
       r.isDuplicateName = true
       // Try to extract a meaningful location identifier
       const addr = r.schoolAddress || ''
       const match = addr.match(/([a-zA-Z0-9\s]+)(?:City|Province|St\.|Ave)/i)
       r.branchIdentifier = match ? match[1].trim() : addr.substring(0, 20) + '...'
    }
  })

  if (type !== 'All') {
    results = results.filter((g) => g.schoolType === type)
  }
  return results
})

const defaultGroups = computed(() => {
  return groupedResults.value.slice(0, visibleSchoolLimit.value)
})

const totalGroupedCount = computed(() => groupedResults.value.length)

function loadMoreSchools() {
  visibleSchoolLimit.value += 5
}

watch(filterType, () => {
  visibleSchoolLimit.value = 5
})

const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  let results = groupedResults.value
  
  // Filter by query (school name)
  if (q) {
    results = results.filter((g) => g.schoolName.toLowerCase().includes(q))
  }
  
  return results
})

const showEmptyState = computed(() => {
  const q = searchQuery.value.trim()
  return !q
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
            @click="currentView = 'admin'"
            class="inline-flex items-center gap-2 text-sm font-medium transition-colors"
            :class="currentView === 'admin' ? 'text-sky-600' : 'text-slate-500 hover:text-slate-700'"
          >
            <LayoutDashboard :size="18" />
            Admin Dashboard
          </button>
          <button
            type="button"
            @click="currentView = 'trash'"
            class="inline-flex items-center gap-2 text-sm font-medium transition-colors relative"
            :class="currentView === 'trash' ? 'text-red-600' : 'text-slate-500 hover:text-red-500'"
          >
            <div class="relative">
               <Trash2 :size="18" :class="{ 'animate-bounce text-red-500': trashAnimating }" />
               <span v-if="trashCount > 0" class="absolute -top-2 -right-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center border-2 border-white shadow-sm transition-all duration-300 scale-100" :class="{'scale-125': trashAnimating}">{{ trashCount }}</span>
            </div>
            Trash Bin
          </button>
          <button
            type="button"
            @click="currentView = 'registration'"
            class="inline-flex items-center gap-2 text-sm font-medium transition-colors hover:text-sky-600"
            :class="currentView === 'registration' ? 'text-sky-600' : 'text-slate-500'"
          >
            <Plus :size="18" />
            Create School
          </button>
        </nav>
      </div>
    </header>

    <!-- ─── Admin Dashboard view (Summary + Search) ────────────────────────── -->
    <main v-if="currentView === 'admin'" class="max-w-6xl mx-auto px-4 py-8">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
         <div>
            <h2 class="text-2xl font-bold text-slate-800">Admin Dashboard</h2>
            <p class="text-slate-600">System Overview & Permit Management</p>
         </div>
      </div>

      <!-- System Overview -->
      <div class="mb-12">
        <div class="flex items-center gap-2 mb-4">
           <LayoutDashboard class="w-5 h-5 text-sky-600" />
           <h3 class="text-lg font-bold text-slate-800">System Overview</h3>
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 animate-in fade-in slide-in-from-top-4 duration-300">
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

           <!-- Level Breakdown -->
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

      <!-- Public Search Section -->
      <div>
         <div class="flex items-center gap-2 mb-6">
            <Search class="w-5 h-5 text-sky-600" />
            <h3 class="text-xl font-bold text-slate-800">Permit Search</h3>
         </div>

         <!-- Search Input & Filter -->
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
                :class="searchError ? 'border-red-300 focus:ring-red-500 focus:border-red-500' : ''"
              />
              <div v-if="searchError" class="mt-1 text-xs text-red-600">{{ searchError }}</div>
            </div>
            <CustomSelect
              v-model="filterType"
              :options="[
                { value: 'All', label: 'All Types' },
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

          <!-- Available Schools List (Default State) -->
         <!-- Unified List Container with Sticky Map -->
      <div v-else-if="showEmptyState || searchResults.length > 0" class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <!-- Left: List of Schools -->
          <div class="lg:col-span-2 space-y-4">
            
            <!-- Default View: Available Schools Card -->
            <div v-if="showEmptyState" class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col max-h-[600px]">
              <div class="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center sticky top-0 z-10">
                 <div class="flex items-center gap-2">
                   <Building2 :size="18" class="text-slate-400" />
                   <h3 class="font-semibold text-slate-700">Available Schools</h3>
                 </div>
                 <span class="text-xs text-slate-500 font-medium px-2 py-1 bg-white rounded border border-slate-200">
                    {{ totalGroupedCount }} total
                 </span>
              </div>

              <div class="overflow-y-auto p-4 space-y-4 custom-scrollbar">
                  <ul class="space-y-4 relative">
                    <li
                      v-for="group in defaultGroups"
                      :key="group.schoolId"
                      class="group bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden relative z-10 cursor-pointer transition-all hover:border-sky-300"
                      :class="selectedSchool?.schoolId === group.schoolId ? 'ring-2 ring-sky-500 border-transparent' : ''"
                      @click="selectSchool(group.schoolId)"
                    >
                      <div class="p-5">
                        <div class="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
                          <div class="flex items-center gap-3">
                            <div>
                              <h3 class="font-semibold text-slate-800 text-lg">
                                {{ group.schoolName }}
                                <span v-if="group.isDuplicateName" class="text-xs font-normal text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded ml-2">
                                  {{ group.branchIdentifier }}
                                </span>
                              </h3>
                              <p class="text-sm text-slate-500">{{ group.schoolAddress }}</p>
                            </div>
                            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button @click.stop="openEditSchool(group.schoolId)" class="p-1.5 text-slate-400 hover:text-sky-600 rounded-lg hover:bg-sky-50 transition-colors" title="Edit School">
                                <Pencil :size="14" />
                              </button>
                              <button @click.stop="deleteSchool(group.schoolId)" class="p-1.5 text-slate-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors" title="Delete School">
                                <Trash2 :size="14" />
                              </button>
                            </div>
                          </div>
                          <div class="flex gap-2 shrink-0">
                            <span 
                              class="px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap"
                              :class="{
                                'bg-purple-50 text-purple-700 border-purple-200': group.schoolType === 'Private',
                                'bg-blue-50 text-blue-700 border-blue-200': group.schoolType === 'Public',
                                'bg-orange-50 text-orange-700 border-orange-200': group.schoolType === 'Homeschooling'
                              }"
                            >
                              {{ group.schoolType }}
                            </span>
                            <span 
                              class="px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap"
                              :class="{
                                'bg-emerald-50 text-emerald-700 border-emerald-200': getOverallSchoolStatus(group.permits).color === 'green',
                                'bg-amber-50 text-amber-700 border-amber-200': getOverallSchoolStatus(group.permits).color === 'yellow',
                                'bg-red-50 text-red-700 border-red-200': getOverallSchoolStatus(group.permits).color === 'red',
                                'bg-gray-50 text-gray-700 border-gray-200': getOverallSchoolStatus(group.permits).color === 'gray'
                              }"
                            >
                              Status: {{ getOverallSchoolStatus(group.permits).label }}
                            </span>
                          </div>
                        </div>
    
                        <!-- List of permits -->
                        <div class="space-y-4">
                          <div 
                            v-for="(p) in group.permits" 
                            :key="p.id" 
                            class="group/permit pt-4 first:pt-0 border-t border-slate-100 first:border-0"
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
                              <div class="text-sm text-slate-600 flex items-center gap-2">
                                <span>Permit No. {{ p.permitNumber || '—' }}</span> 
                                <span class="opacity-50">|</span> 
                                <span>SY {{ p.schoolYear || '—' }}</span>
                                <span class="text-xs text-slate-400">Edit via school</span>
                              </div>
                              <button
                                v-if="p.filePreviewUrl"
                                @click.stop="openPreview(p)"
                                class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100 transition-colors"
                              >
                                <FileImage :size="16" />
                                View File
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </li>
                  </ul>

                  <div v-if="defaultGroups.length === 0" class="text-center py-12">
                     <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-50 text-slate-400 mb-3">
                       <Search :size="32" stroke-width="1.5" />
                     </div>
                     <p class="text-slate-500 font-medium">No schools found</p>
                 </div>

                 <button 
                    v-if="defaultGroups.length < totalGroupedCount"
                   @click="loadMoreSchools"
                   class="w-full py-3 text-sm text-sky-600 font-semibold hover:bg-sky-50 rounded-xl transition-colors border border-dashed border-sky-200 mt-2 flex items-center justify-center gap-2"
                 >
                   <span>See More</span>
                   <span class="px-1.5 py-0.5 bg-sky-100 text-sky-700 rounded text-xs">
                      {{ Math.min(5, totalGroupedCount - defaultGroups.length) }}
                   </span>
                 </button>
              </div>
           </div>

           <!-- Search Results View -->
           <template v-else>
               <div 
                v-for="group in searchResults" 
                :key="group.schoolId"
                class="group bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden relative z-10 cursor-pointer transition-all hover:border-sky-300"
                :class="selectedSchool?.schoolId === group.schoolId ? 'ring-2 ring-sky-500 border-transparent' : ''"
                @click="selectSchool(group.schoolId)"
              >
                <!-- Search Result Card Content (Identical to previous) -->
                <div class="p-5">
                  <div class="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
                    <div class="flex items-center gap-3">
                      <div>
                              <h3 class="font-semibold text-slate-800 text-lg">
                                {{ group.schoolName }}
                                <span v-if="group.isDuplicateName" class="text-xs font-normal text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded ml-2">
                                  {{ group.branchIdentifier }}
                                </span>
                              </h3>
                              <p class="text-sm text-slate-500">{{ group.schoolAddress }}</p>
                            </div>
                      <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button @click.stop="openEditSchool(group.schoolId)" class="p-1.5 text-slate-400 hover:text-sky-600 rounded-lg hover:bg-sky-50 transition-colors" title="Edit School">
                          <Pencil :size="14" />
                        </button>
                        <button @click.stop="deleteSchool(group.schoolId)" class="p-1.5 text-slate-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors" title="Delete School">
                          <Trash2 :size="14" />
                        </button>
                      </div>
                    </div>
                    <div class="flex gap-2 shrink-0">
                      <span 
                        class="px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap"
                        :class="{
                          'bg-purple-50 text-purple-700 border-purple-200': group.schoolType === 'Private',
                          'bg-blue-50 text-blue-700 border-blue-200': group.schoolType === 'Public',
                          'bg-orange-50 text-orange-700 border-orange-200': group.schoolType === 'Homeschooling'
                        }"
                      >
                        {{ group.schoolType }}
                      </span>
                      <span 
                        class="px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap"
                        :class="{
                          'bg-emerald-50 text-emerald-700 border-emerald-200': getOverallSchoolStatus(group.permits).color === 'green',
                          'bg-amber-50 text-amber-700 border-amber-200': getOverallSchoolStatus(group.permits).color === 'yellow',
                          'bg-red-50 text-red-700 border-red-200': getOverallSchoolStatus(group.permits).color === 'red',
                          'bg-gray-50 text-gray-700 border-gray-200': getOverallSchoolStatus(group.permits).color === 'gray'
                        }"
                      >
                        Status: {{ getOverallSchoolStatus(group.permits).label }}
                      </span>
                    </div>
                  </div>

                  <!-- List of permits -->
                  <div class="space-y-4">
                    <div 
                      v-for="(p) in group.permits" 
                      :key="p.id" 
                      class="group/permit pt-4 first:pt-0 border-t border-slate-100 first:border-0"
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
                        <div class="text-sm text-slate-600 flex items-center gap-2">
                          <div class="flex flex-col sm:flex-row sm:items-center">
                              <span v-if="p.permitNumber">Permit No. {{ p.permitNumber }}</span>
                              <span v-if="p.permitNumber" class="hidden sm:inline text-slate-300 mx-2">|</span>
                              <span :class="{'block text-xs text-slate-400 mt-1 sm:inline sm:text-sm sm:text-slate-600 sm:mt-0': p.permitNumber}">
                                SY {{ p.schoolYear }}
                              </span>
                          </div>
                          
                          <div class="flex items-center gap-1 opacity-0 group-hover/permit:opacity-100 transition-opacity ml-2">
                             <span class="text-xs text-slate-400">Edit via school</span>
                          </div>
                        </div>
                        
                        <button
                          v-if="p.filePreviewUrl"
                          type="button"
                          @click.stop="openPreview(p)"
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
              </div>
           </template>

          </div>

          <!-- Right: Sticky Map -->
          <div class="hidden lg:block lg:col-span-1">
             <div class="sticky top-6">
                <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
                   <div class="p-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                      <h3 class="font-semibold text-slate-700 text-sm flex items-center gap-2">
                         <MapPin :size="16" />
                         School Location
                      </h3>
                      <span v-if="selectedSchool" class="text-xs text-slate-500 truncate max-w-[150px]">
                         {{ selectedSchool.name }}
                      </span>
                      <span v-else class="text-xs text-slate-400 italic">Select a school</span>
                   </div>
                   <div class="flex-1 relative bg-slate-100">
                      <div ref="mapContainerView" class="absolute inset-0 z-0"></div>
                      <div v-if="!selectedSchool" class="absolute inset-0 flex items-center justify-center bg-slate-50/80 backdrop-blur-sm z-10 p-6 text-center">
                         <div>
                            <MapPin :size="48" class="text-slate-300 mx-auto mb-2" />
                            <p class="text-slate-500 font-medium">Select a school to view map</p>
                            <p class="text-xs text-slate-400 mt-1">Click on any school card from the list</p>
                         </div>
                      </div>
                   </div>
                </div>
             </div>
          </div>
      </div>
        
        <div v-else class="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center">
          <div class="inline-flex items-center justify-center w-20 h-20 rounded-full bg-slate-50 text-slate-400 mb-4">
            <Search :size="40" stroke-width="1.5" />
          </div>
          <p class="text-slate-800 font-medium mb-1">No results found</p>
          <p class="text-sm text-slate-500">Try a different school name or adjust the filter</p>
        </div>
      </div>
    </main>

    <!-- ─── Trash View ──────────────────────────────────────────────────── -->
    <main v-else-if="currentView === 'trash'" class="max-w-4xl mx-auto px-4 py-8">
       <div class="flex items-center gap-3 mb-6">
          <div class="p-2 bg-red-100 text-red-600 rounded-lg">
             <Trash2 :size="24" />
          </div>
          <div>
             <h2 class="text-2xl font-bold text-slate-800">Trash Bin</h2>
             <p class="text-slate-600">Restore deleted items or remove them forever. Items are auto-deleted after 15 days.</p>
          </div>
       </div>

       <!-- Loading -->
       <div v-if="trashLoading" class="py-12 text-center text-slate-500">
          <Loader2 class="w-8 h-8 animate-spin mx-auto mb-2 text-slate-400" />
          Loading trash...
       </div>

       <!-- Unified List -->
       <div v-else class="space-y-4">
          <div v-if="unifiedTrash.length === 0" class="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-200">
             <p class="text-slate-500">Trash bin is empty.</p>
          </div>
          
          <div v-for="item in unifiedTrash" :key="item.type + item.id" class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between group hover:border-sky-200 transition-all">
             <div class="flex items-start gap-4">
                <div class="mt-1 p-2 rounded-lg" :class="item.type === 'school' ? 'bg-purple-50 text-purple-600' : 'bg-blue-50 text-blue-600'">
                   <component :is="item.type === 'school' ? Building2 : Shield" :size="20" />
                </div>
                <div>
                   <div class="flex items-center gap-2 mb-1">
                      <h3 class="font-semibold text-slate-800">{{ item.title }}</h3>
                      <span class="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide" :class="item.badgeColor">
                         {{ item.type }}
                      </span>
                   </div>
                   <p class="text-sm text-slate-500">{{ item.subtitle }}</p>
                   <p class="text-xs text-slate-400 mt-1">Deleted: {{ new Date(item.deletedAt).toLocaleDateString() }}</p>
                </div>
             </div>
             
             <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button @click="restoreItem(item.type, item.id)" class="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg flex items-center gap-1 text-sm font-medium transition-colors">
                   <RotateCcw :size="16" /> Restore
                </button>
                <button @click="deleteForever(item.type, item.id)" class="p-2 text-red-600 hover:bg-red-50 rounded-lg flex items-center gap-1 text-sm font-medium transition-colors">
                   <Trash2 :size="16" /> Delete Forever
                </button>
             </div>
          </div>
       </div>
    </main>

    <!-- ─── Create School View ───────────────────────────────────────────── -->
    <main v-else-if="currentView === 'registration'" class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex items-center gap-3 mb-6">
         <div class="p-2 bg-sky-100 text-sky-600 rounded-lg">
            <Plus :size="24" />
         </div>
         <div>
            <h2 class="text-2xl font-bold text-slate-800">Create School</h2>
            <p class="text-slate-600">Register new schools or homeschooling providers</p>
         </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <!-- Left Column: Form -->
        <section class="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <h3 class="text-lg font-semibold text-slate-800">New Application</h3>
            
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

              <!-- OCR Confidence Alert -->
              <div v-if="schoolForm.extractedText" class="mt-3 pt-3 border-t border-slate-200">
                 <div v-if="schoolForm.ocrConfidence < 70" class="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                    <div class="p-1 bg-amber-100 rounded text-amber-600 shrink-0">
                       <AlertTriangle :size="16" />
                    </div>
                    <div>
                       <h4 class="text-sm font-semibold text-amber-800">Low Confidence Scan ({{ schoolForm.ocrConfidence }}%)</h4>
                       <p class="text-xs text-amber-700 mt-0.5">Some details might be inaccurate. Please review the highlighted fields carefully.</p>
                       <ul v-if="schoolForm.ocrErrors && schoolForm.ocrErrors.length" class="mt-2 list-disc list-inside text-xs text-amber-700 capitalize">
                          <li v-for="err in schoolForm.ocrErrors" :key="err">{{ err.replace(/_/g, ' ').toLowerCase() }}</li>
                       </ul>
                       <button type="button" @click="verifyScan" class="mt-2 text-xs font-semibold bg-amber-200 text-amber-800 px-2 py-1 rounded hover:bg-amber-300 transition-colors">
                          Mark as Verified
                       </button>
                    </div>
                 </div>
                 <div v-else class="flex items-center gap-2 text-sm text-emerald-600 font-medium">
                    <CheckCircle :size="16" />
                    <span>High Confidence Scan ({{ schoolForm.ocrConfidence }}%)</span>
                 </div>
              </div>
            </div>

          <!-- Name Field (Dynamic Label) -->
          <div>
            <div class="flex items-center justify-between mb-1">
              <label for="schoolName" class="block text-sm font-medium text-slate-700">
                {{ createTab === 'school' ? 'School Name' : 'Homeschooling Provider Name' }} <span class="text-red-500">*</span>
              </label>
              <span v-if="schoolForm.ocrErrors?.includes('MISSING_SCHOOL_NAME') || schoolForm.ocrErrors?.includes('SCHOOL_NAME_TOO_SHORT')" class="text-xs font-medium text-amber-600 flex items-center gap-1">
                 <AlertTriangle :size="12" /> Check Name
              </span>
            </div>
            <input
              id="schoolName"
              v-model="schoolForm.name"
              type="text"
              :placeholder="createTab === 'school' ? 'e.g., St. Mary\'s Academy' : 'e.g., Happy Homeschool Center'"
              class="w-full px-3 py-2 rounded-lg border focus:ring-2 outline-none transition-colors"
              :class="[
                schoolFormErrors.name ? 'border-red-500 focus:ring-red-200' : 
                (schoolForm.ocrErrors?.includes('MISSING_SCHOOL_NAME') || schoolForm.ocrErrors?.includes('SCHOOL_NAME_TOO_SHORT')) ? 'border-amber-300 bg-amber-50 focus:border-amber-500 focus:ring-amber-200' : 
                'border-slate-300 focus:ring-sky-500 focus:border-sky-500'
              ]"
            />
            <p v-if="schoolFormErrors.name" class="mt-1 text-sm text-red-600">{{ schoolFormErrors.name }}</p>
          </div>

          <!-- Common Address Field -->
          <div>
            <div class="flex items-center justify-between mb-1">
               <label for="schoolAddress" class="block text-sm font-medium text-slate-700">Address</label>
               <span v-if="schoolForm.ocrErrors?.includes('MISSING_ADDRESS') || schoolForm.ocrErrors?.includes('ADDRESS_LIKELY_INCOMPLETE')" class="text-xs font-medium text-amber-600 flex items-center gap-1">
                 <AlertTriangle :size="12" /> Check Address
              </span>
            </div>
            <input
              id="schoolAddress"
              v-model="schoolForm.address"
              @input="sanitizeAddressInput"
              type="text"
              placeholder="e.g. Main Street City Province"
              class="w-full px-3 py-2 rounded-lg border focus:ring-2 outline-none transition-colors"
              :class="[
                 (schoolForm.ocrErrors?.includes('MISSING_ADDRESS') || schoolForm.ocrErrors?.includes('ADDRESS_LIKELY_INCOMPLETE')) ? 'border-amber-300 bg-amber-50 focus:border-amber-500 focus:ring-amber-200' : 
                 'border-slate-300 focus:ring-sky-500 focus:border-sky-500'
              ]"
            />
            
            <!-- Map Section -->
            <div class="mt-2 mb-4">
               <div class="flex items-center justify-between mb-1">
                  <span class="text-xs text-slate-500">Location Map</span>
                  <span class="text-xs text-sky-600 font-medium">Click on map to pin exact location</span>
               </div>
               <div ref="mapContainer" class="w-full h-64 rounded-lg border border-slate-300 z-0 bg-slate-50 cursor-crosshair"></div>
               <div v-if="isGeocoding" class="flex items-center gap-2 text-xs text-slate-500 mt-1">
                  <Loader2 class="w-3 h-3 animate-spin" />
                  Locating address on map...
               </div>
               <div v-if="geocodeError" class="text-xs text-red-500 mt-1 flex items-center gap-1">
                  <XCircle class="w-3 h-3" />
                  {{ geocodeError }}
               </div>
            </div>
          </div>

          <!-- Permit Details (Loop for Multiple Permits) -->
          <div v-if="createTab !== 'homeschool'" class="mt-6 pt-6 border-t border-slate-200 animate-in fade-in slide-in-from-top-4 duration-500 space-y-6">
             <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                   <div class="p-1 rounded bg-emerald-100 text-emerald-600">
                      <Shield :size="16" />
                   </div>
                   <h3 class="text-sm font-semibold text-slate-800">
                     {{ createTab === 'school' ? 'Permit Details' : 'Application Data' }}
                   </h3>
                </div>
                <button 
                   type="button"
                   @click="schoolForm.permits.push({ permitNumber: '', schoolYear: '', levels: [], strands: [] })"
                   class="text-xs font-medium text-sky-600 hover:text-sky-800 bg-sky-50 px-2 py-1 rounded transition-colors"
                >
                   + Add Another Permit
                </button>
             </div>

             <div 
               v-for="(permit, idx) in schoolForm.permits" 
               :key="idx" 
               class="bg-slate-50 p-4 rounded-xl border border-slate-200 relative group transition-all hover:border-sky-200"
             >
                <!-- Remove Button -->
                <button
                   v-if="schoolForm.permits.length > 1"
                   type="button"
                   @click="schoolForm.permits.splice(idx, 1)"
                   class="absolute top-2 right-2 p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                   title="Remove this permit"
                >
                   <Trash2 :size="16" />
                </button>

                <div class="space-y-4">
                  <!-- Levels -->
                  <div>
                    <label class="block text-sm font-medium text-slate-700 mb-2">Program / Level</label>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label 
                        v-for="opt in levelOptions" 
                        :key="opt.value" 
                        class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-200"
                        :class="permit.levels.includes(opt.value) ? 'border-sky-500 bg-white shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'"
                      >
                        <div 
                          class="w-5 h-5 rounded border flex items-center justify-center transition-colors"
                          :class="permit.levels.includes(opt.value) ? 'bg-sky-500 border-sky-500' : 'border-slate-300 bg-white'"
                        >
                          <CheckCircle v-if="permit.levels.includes(opt.value)" class="w-3.5 h-3.5 text-white" />
                        </div>
                        <input 
                          type="checkbox" 
                          :value="opt.value" 
                          v-model="permit.levels"
                          class="hidden"
                        >
                        <span class="text-sm font-medium" :class="permit.levels.includes(opt.value) ? 'text-sky-900' : 'text-slate-700'">
                          {{ opt.label }}
                        </span>
                      </label>
                    </div>
                  </div>

                  <!-- Permit No & SY -->
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                       <label class="block text-sm font-medium text-slate-700 mb-1">Permit Number</label>
                       <div class="relative overflow-hidden rounded-lg">
                          <input 
                            v-model="permit.permitNumber"
                            type="text"
                            class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none pr-10"
                            :class="[
                               permit.permitNumber && schoolForm.extractedText ? 'bg-emerald-50 border-emerald-200' : '',
                               schoolForm.ocrLoading ? 'border-sky-400 ring-2 ring-sky-100' : ''
                            ]"
                          />
                          <div v-if="permit.permitNumber && schoolForm.extractedText" class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 flex items-center gap-1 text-xs font-medium">
                             <CheckCircle :size="14" />
                             Match
                          </div>
                       </div>
                    </div>
                    <div>
                       <label class="block text-sm font-medium text-slate-700 mb-1">School Year</label>
                       <div class="relative">
                          <input 
                            v-model="permit.schoolYear"
                            type="text"
                            class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none"
                            :class="permit.schoolYear && schoolForm.extractedText ? 'bg-emerald-50 border-emerald-200' : ''"
                          />
                          <div v-if="permit.schoolYear && schoolForm.extractedText" class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 flex items-center gap-1 text-xs font-medium">
                             <CheckCircle :size="14" />
                             Match
                          </div>
                       </div>
                    </div>
                  </div>

                  <!-- Strands -->
                  <div v-if="permit.levels.includes('Senior High School')" class="animate-in fade-in slide-in-from-top-2 pt-4 border-t border-slate-200 mt-4">
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
                          v-model="permit.strands"
                          class="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                        >
                        <span class="text-sm text-slate-700">{{ strand }}</span>
                      </label>
                    </div>
                  </div>
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

      <!-- Right Column: File Preview -->
      <div class="hidden lg:block lg:sticky lg:top-6 space-y-6">
         <div v-if="schoolForm.filePreviewUrl" class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-[calc(100vh-120px)] flex flex-col">
            <div class="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
               <h3 class="font-medium text-slate-700 text-sm flex items-center gap-2">
                  <FileImage :size="16" />
                  Document Preview
               </h3>
               <div class="flex items-center gap-3">
                  <div v-if="schoolForm.file?.type.startsWith('image/')" class="flex items-center gap-1 border-r border-slate-200 pr-3 mr-3">
                    <button type="button" @click="rotateImage(-90)" class="p-1 hover:bg-slate-200 rounded text-slate-500 transition-colors" title="Rotate Left">
                       <RotateCcw :size="14" />
                    </button>
                    <button type="button" @click="rotateImage(90)" class="p-1 hover:bg-slate-200 rounded text-slate-500 transition-colors" title="Rotate Right">
                       <RotateCw :size="14" />
                    </button>
                    <!-- Fine Rotation -->
                     <div class="flex items-center gap-1 ml-2 border-l border-slate-200 pl-2">
                        <span class="text-[10px] text-slate-400 font-mono">TILT</span>
                        <button type="button" @click="rotateImage(-0.5)" class="p-1 hover:bg-slate-200 rounded text-slate-500 transition-colors" title="Tilt Left 0.5°">
                           <Minus :size="10" />
                        </button>
                        <button type="button" @click="rotateImage(0.5)" class="p-1 hover:bg-slate-200 rounded text-slate-500 transition-colors" title="Tilt Right 0.5°">
                           <Plus :size="10" />
                        </button>
                     </div>
                  </div>
                  <span class="text-xs text-slate-500 truncate max-w-[150px]">{{ schoolForm.fileName }}</span>
               </div>
            </div>
            <div class="flex-1 bg-slate-100 overflow-hidden relative">
               <iframe 
                  v-if="schoolForm.fileName?.toLowerCase().endsWith('.pdf')"
                  :src="schoolForm.filePreviewUrl" 
                  class="w-full h-full border-0"
               ></iframe>
               <div v-else class="w-full h-full overflow-auto flex items-center justify-center p-4">
                  <img :src="schoolForm.filePreviewUrl" class="max-w-full h-auto shadow-sm rounded border border-slate-200" />
               </div>
            </div>
         </div>
         
         <div v-else class="bg-slate-50 rounded-xl border border-dashed border-slate-300 p-8 text-center h-64 flex flex-col items-center justify-center text-slate-400">
            <FileImage :size="48" class="mb-4 opacity-50" />
            <p class="text-sm font-medium">No document uploaded</p>
            <p class="text-xs mt-1">Upload a file to see preview here</p>
         </div>
      </div>
    </div> <!-- End Grid -->
  </main>

    <div
      v-if="previewPermit"
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] px-4"
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
    <!-- ─── Modals ──────────────────────────────────────────────────────── -->
    
    <!-- Map Modal -->
    <div v-if="isMapModalOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-4xl h-[80vh] overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col relative">
        <div class="absolute top-4 right-4 z-[1000] flex gap-2">
           <button @click="openDetailsFromMap" class="bg-white/90 backdrop-blur text-slate-700 px-3 py-1.5 rounded-lg shadow-md text-sm font-medium hover:bg-white hover:text-sky-600 transition-colors flex items-center gap-2">
              <Building2 :size="16" />
              View Details
           </button>
           <button @click="closeMapModal" class="bg-white/90 backdrop-blur text-slate-700 p-1.5 rounded-lg shadow-md hover:bg-red-50 hover:text-red-600 transition-colors">
              <XCircle :size="20" />
           </button>
        </div>
        <div ref="mapModalContainer" class="w-full h-full z-0"></div>
      </div>
    </div>

    <!-- Edit School Modal -->
    <div v-if="isEditingSchool" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-5xl overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        <div class="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
          <h3 class="font-bold text-slate-800 text-lg">Edit School</h3>
          <button @click="isEditingSchool = false" class="text-slate-400 hover:text-slate-600">
            <XCircle :size="20" />
          </button>
        </div>
        
        <div class="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-2">
          <!-- Left: Form Fields -->
          <div class="p-6 overflow-y-auto max-h-[70vh]">
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-slate-700 mb-1">School Name</label>
                <input v-model="editSchoolForm.name" type="text" class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none" />
              </div>
              
              <div>
                <label class="block text-sm font-medium text-slate-700 mb-1">Type</label>
                <div class="flex gap-4">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="radio" v-model="editSchoolForm.type" value="Private" class="text-sky-600 focus:ring-sky-500" />
                    <span class="text-sm text-slate-700">Private</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="radio" v-model="editSchoolForm.type" value="Homeschooling" class="text-sky-600 focus:ring-sky-500" />
                    <span class="text-sm text-slate-700">Homeschooling</span>
                  </label>
                </div>
              </div>

              <div>
                <label class="block text-sm font-medium text-slate-700 mb-1">Address</label>
                <div class="flex gap-2">
                   <input 
                      v-model="editSchoolForm.address" 
                      type="text" 
                      placeholder="e.g. Brgy. Banay-Banay, Cabuyao City"
                      class="flex-1 px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none" 
                      @input="debounceGeocodeEdit"
                   />
                   <button 
                      @click="geocodeEditAddress"
                      type="button"
                      class="px-3 py-2 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 border border-slate-200 transition-colors"
                      title="Locate on map"
                   >
                      <MapPin :size="18" />
                   </button>
                </div>
                <p class="text-xs text-slate-500 mt-1">
                   Typing the address will automatically update the map location. You can also drag the pin on the map.
                </p>
              </div>

              <div class="pt-4 border-t border-slate-100">
                <h4 class="font-semibold text-slate-800 mb-2 flex items-center gap-2">
                   <History class="w-4 h-4 text-sky-600" />
                   Permits
                </h4>
                <div v-if="editSchoolPermits.length === 0" class="text-sm text-slate-500 italic">No permits found for this school.</div>
                <div v-else class="space-y-4 max-h-[30vh] overflow-y-auto pr-2">
                  <div 
                    v-for="p in editSchoolPermits" 
                    :key="p.id" 
                    class="rounded-lg border border-slate-200 p-3 bg-slate-50 hover:bg-white hover:border-sky-200 transition-all"
                  >
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-2">
                      <div>
                        <label class="block text-xs font-medium text-slate-600 mb-1">Permit Number</label>
                        <input v-model="p.permitNumber" type="text" class="w-full px-2 py-1.5 rounded border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none text-sm bg-white" />
                      </div>
                      <div>
                        <label class="block text-xs font-medium text-slate-600 mb-1">School Year</label>
                        <input v-model="p.schoolYear" type="text" class="w-full px-2 py-1.5 rounded border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none text-sm bg-white" />
                      </div>
                    </div>
                    <div>
                      <label class="block text-xs font-medium text-slate-600 mb-1">Levels</label>
                      <div class="flex flex-wrap gap-2">
                        <label 
                          v-for="opt in levelOptions" 
                          :key="opt.value"
                          class="inline-flex items-center gap-2 px-2 py-1 rounded border text-xs cursor-pointer bg-white transition-colors"
                          :class="p.levels.includes(opt.value) ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-600'"
                        >
                          <input 
                            type="checkbox"
                            :value="opt.value"
                            class="rounded text-sky-600 focus:ring-sky-500"
                            :checked="p.levels.includes(opt.value)"
                            @change="() => { const i = p.levels.indexOf(opt.value); if (i>=0) p.levels.splice(i,1); else p.levels.push(opt.value); }"
                          >
                          <span>{{ opt.label }}</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Right: Interactive Map -->
          <div class="relative bg-slate-100 min-h-[600px] border-l border-slate-200 flex flex-col">
             <div ref="mapContainerEdit" class="absolute inset-0 z-0 cursor-crosshair"></div>
             
             <!-- Map Overlay Controls (Top Right) -->
             <div class="absolute top-4 right-4 z-[400] flex flex-col gap-2">
                <div class="bg-white/90 backdrop-blur p-2 rounded-lg shadow-md text-xs text-slate-600 max-w-[200px]">
                   <p class="font-semibold mb-1">Map Instructions</p>
                   <ul class="list-disc list-inside space-y-1">
                      <li>Drag marker to refine location</li>
                      <li>Click anywhere to move marker</li>
                   </ul>
                </div>
             </div>

             <!-- Coordinates Display (Bottom) -->
             <div class="absolute bottom-4 left-4 right-4 z-[400]">
                <div class="bg-white/90 backdrop-blur px-3 py-2 rounded-lg shadow-md flex items-center gap-4 text-xs text-slate-600 border border-slate-200">
                   <div class="flex items-center gap-1">
                      <span class="font-semibold">Lat:</span>
                      <span class="font-mono">{{ editSchoolForm.latitude ? parseFloat(editSchoolForm.latitude).toFixed(6) : 'N/A' }}</span>
                   </div>
                   <div class="w-px h-3 bg-slate-300"></div>
                   <div class="flex items-center gap-1">
                      <span class="font-semibold">Lng:</span>
                      <span class="font-mono">{{ editSchoolForm.longitude ? parseFloat(editSchoolForm.longitude).toFixed(6) : 'N/A' }}</span>
                   </div>
                   <div v-if="isGeocodingEdit" class="ml-auto flex items-center gap-2 text-sky-600">
                      <Loader2 class="w-3 h-3 animate-spin" />
                      <span>Locating...</span>
                   </div>
                </div>
             </div>
          </div>
        </div>

        <div class="px-6 py-4 bg-slate-50 flex justify-end gap-3 shrink-0 border-t border-slate-100">
          <button @click="isEditingSchool = false" class="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800">Cancel</button>
          <button @click="saveEditSchool" class="px-4 py-2 text-sm font-medium text-white bg-sky-600 rounded-lg hover:bg-sky-700 shadow-sm">Save Changes</button>
        </div>
      </div>
    </div>

    <!-- School Details Modal -->
    <div v-if="selectedSchool" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-6xl overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        <!-- Header -->
        <div class="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
          <div>
            <h3 class="font-bold text-slate-800 text-lg">{{ selectedSchool.schoolName }}</h3>
            <div class="flex items-center gap-2 mt-1">
              <span :class="getStatusBadgeClass(selectedSchool.status)" class="text-xs font-medium px-2 py-0.5 rounded-full border">
                {{ selectedSchool.status }}
              </span>
              <span class="text-sm text-slate-500">• {{ selectedSchool.schoolType }}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button 
              @click="openEditSchool(selectedSchool.schoolId)"
              class="text-xs font-medium text-slate-600 hover:text-sky-600 flex items-center gap-1 bg-white border border-slate-200 hover:border-sky-300 px-3 py-1.5 rounded-lg transition-colors shadow-sm"
            >
              <Pencil :size="14" />
              Edit Info
            </button>
            <button 
              @click="deleteSchool(selectedSchool.schoolId)"
              class="text-xs font-medium text-red-600 hover:text-red-700 flex items-center gap-1 bg-white border border-slate-200 hover:border-red-300 px-3 py-1.5 rounded-lg transition-colors shadow-sm"
            >
              <Trash2 :size="14" />
              Delete
            </button>
            <div class="w-px h-6 bg-slate-200 mx-1"></div>
            <button @click="closeSchoolDetails" class="text-slate-400 hover:text-slate-600 transition-colors">
              <XCircle :size="24" />
            </button>
          </div>
        </div>

        <!-- Body Grid -->
        <div class="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-2">
          <!-- Left: Details -->
          <div class="p-6 overflow-y-auto max-h-[70vh]">
            <!-- Address -->
            <div class="mb-6 flex items-start gap-3">
              <MapPin class="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <p class="text-sm font-medium text-slate-700">Address</p>
                <p class="text-slate-600">{{ selectedSchool.schoolAddress || 'No address provided' }}</p>
              </div>
            </div>

            <!-- Permit History -->
            <div class="mb-6">
              <div class="flex items-center justify-between mb-4">
                <h4 class="font-semibold text-slate-800 flex items-center gap-2">
                  <History class="w-4 h-4 text-sky-600" />
                  Permit History
                </h4>
              <button 
                @click="openRenewPermit(selectedSchool.schoolId)" 
                class="text-sm font-medium text-sky-600 hover:text-sky-700 flex items-center gap-1 hover:bg-sky-50 px-2 py-1 rounded-lg transition-colors"
              >
                <Plus :size="16" />
                Renew / Add Permit
              </button>
            </div>

            <div v-if="selectedSchool.permits.length === 0" class="text-center py-8 bg-slate-50 rounded-xl border border-dashed border-slate-200">
              <p class="text-slate-500">No permits found.</p>
            </div>

            <div v-else class="space-y-3">
              <div 
                v-for="permit in selectedSchool.permits.sort((a,b) => (b.schoolYear || '').localeCompare(a.schoolYear || ''))" 
                :key="permit.id" 
                class="bg-white border border-slate-200 rounded-lg p-4 hover:border-sky-300 transition-colors group"
              >
                <div class="flex items-start justify-between">
                  <div>
                    <div class="flex items-center gap-2 mb-1">
                      <span class="font-bold text-slate-800">{{ permit.schoolYear }}</span>
                      <span :class="getStatusBadgeClass(getStatus(permit.schoolYear).label)" class="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider">
                        {{ getStatus(permit.schoolYear).label }}
                      </span>
                    </div>
                    <p class="text-sm text-slate-600 mb-1">Permit No: <span class="font-medium">{{ permit.permitNumber }}</span></p>
                    <div class="flex flex-wrap gap-1">
                      <span v-for="lvl in permit.levels" :key="lvl" class="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                        {{ lvl }}
                      </span>
                    </div>
                  </div>
                  
                  <div class="flex flex-col gap-2">
                     <button 
                       @click="openPreview(permit)" 
                       class="text-xs font-medium text-sky-600 hover:text-sky-700 flex items-center gap-1 bg-sky-50 hover:bg-sky-100 px-2 py-1.5 rounded transition-colors"
                     >
                       <Eye :size="14" />
                       View File
                     </button>
                     <button 
                       @click="downloadFile(permit)" 
                       class="text-xs font-medium text-emerald-600 hover:text-emerald-700 flex items-center gap-1 bg-emerald-50 hover:bg-emerald-100 px-2 py-1.5 rounded transition-colors"
                     >
                       <Download :size="14" />
                       Download
                     </button>
                     <button 
                       @click="openEditPermit(permit)" 
                       class="text-xs font-medium text-slate-500 hover:text-sky-600 flex items-center gap-1 hover:bg-slate-50 px-2 py-1.5 rounded transition-colors"
                     >
                       <Pencil :size="14" />
                       Edit
                     </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
          
          <!-- Right: Map -->
          <div class="relative bg-slate-100 min-h-[600px] border-l border-slate-200">
              <div ref="mapContainerDetails" class="absolute inset-0 z-0"></div>
              <div v-if="!selectedSchool.latitude || !selectedSchool.longitude" class="absolute inset-0 flex items-center justify-center text-slate-400 bg-slate-50/50">
                  <div class="text-center">
                      <MapPinOff :size="32" class="mx-auto mb-2 opacity-50" />
                      <p class="text-sm">No map coordinates</p>
                  </div>
              </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit Permit Modal -->
    <div v-if="isEditingPermit" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200">
        <div class="px-6 py-4 border-b border-slate-100 flex justify-between items-center">
          <h3 class="font-bold text-slate-800">Edit Permit</h3>
          <button @click="isEditingPermit = false" class="text-slate-400 hover:text-slate-600">
            <XCircle :size="20" />
          </button>
        </div>
        <div class="p-6 space-y-4 h-[60vh] overflow-y-auto">
          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1">Permit Number</label>
            <input v-model="editPermitForm.permitNumber" type="text" class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none" />
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1">School Year</label>
            <input v-model="editPermitForm.schoolYear" type="text" class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none" placeholder="YYYY-YYYY" />
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-700 mb-2">Levels</label>
            <div class="grid grid-cols-2 gap-2">
              <label 
                v-for="opt in levelOptions" 
                :key="opt.value" 
                class="flex items-center gap-2 p-2 rounded border cursor-pointer hover:bg-slate-50"
                :class="editPermitForm.levels.includes(opt.value) ? 'border-sky-500 bg-sky-50' : 'border-slate-200'"
              >
                <input 
                  type="checkbox" 
                  :value="opt.value" 
                  class="rounded text-sky-600 focus:ring-sky-500"
                  :checked="editPermitForm.levels.includes(opt.value)"
                  @change="toggleEditPermitLevel(opt.value)"
                >
                <span class="text-sm text-slate-700">{{ opt.label }}</span>
              </label>
            </div>
          </div>
          <div>
             <label class="block text-sm font-medium text-slate-700 mb-1">Replace File (Optional)</label>
             <input type="file" @change="onEditPermitFileChange" class="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-sky-50 file:text-sky-700 hover:file:bg-sky-100" />
             <p v-if="editPermitForm.fileName" class="mt-1 text-xs text-slate-500">Current: {{ editPermitForm.fileName }}</p>
          </div>
        </div>
        <div class="px-6 py-4 bg-slate-50 flex justify-end gap-3">
          <button @click="isEditingPermit = false" class="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800">Cancel</button>
          <button @click="saveEditPermit" class="px-4 py-2 text-sm font-medium text-white bg-sky-600 rounded-lg hover:bg-sky-700">Save Changes</button>
        </div>
      </div>
    </div>

    <!-- Renew Permit Modal -->
    <div v-if="isRenewingPermit" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        <div class="px-6 py-4 border-b border-slate-100 flex justify-between items-center">
          <h3 class="font-bold text-slate-800 flex items-center gap-2">
            <Upload class="text-sky-600" :size="20" />
            Renew / Add Permit
          </h3>
          <button @click="isRenewingPermit = false" class="text-slate-400 hover:text-slate-600">
            <XCircle :size="20" />
          </button>
        </div>
        
        <div class="p-6 space-y-4 overflow-y-auto">
          <!-- File Upload -->
          <div 
            class="border-2 border-dashed border-slate-300 rounded-xl p-6 text-center hover:border-sky-400 hover:bg-sky-50 transition-colors cursor-pointer relative"
            :class="{'border-sky-500 bg-sky-50': permitForm.file}"
          >
            <input 
              type="file" 
              accept=".pdf,image/*" 
              class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              @change="onPermitFileChange"
            />
            <div v-if="ocrLoading" class="flex flex-col items-center justify-center py-4">
              <Loader2 class="animate-spin text-sky-600 mb-2" :size="32" />
              <p class="text-sm font-medium text-slate-600">Scanning document...</p>
            </div>
            <div v-else-if="permitForm.file" class="flex flex-col items-center">
              <FileImage class="text-sky-600 mb-2" :size="32" />
              <p class="text-sm font-medium text-slate-800">{{ permitForm.fileName }}</p>
              <p class="text-xs text-emerald-600 mt-1">Ready to upload</p>
            </div>
            <div v-else class="flex flex-col items-center">
              <Upload class="text-slate-400 mb-2" :size="32" />
              <p class="text-sm font-medium text-slate-600">Click to upload Permit</p>
              <p class="text-xs text-slate-400 mt-1">PDF or Image supported</p>
            </div>
          </div>

          <!-- Fields -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">Permit Number <span class="text-red-500">*</span></label>
              <input 
                v-model="permitForm.permitNumber" 
                type="text" 
                class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                :class="{'border-red-300 focus:ring-red-200': permitFormErrors.permitNumber, 'animate-shimmer bg-gradient-to-r from-transparent via-white/50 to-transparent bg-[length:200%_100%]': ocrLoading}" 
                placeholder="e.g. SHS-012"
              />
              <p v-if="permitFormErrors.permitNumber" class="text-xs text-red-500 mt-1">{{ permitFormErrors.permitNumber }}</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">School Year <span class="text-red-500">*</span></label>
              <input 
                v-model="permitForm.schoolYear" 
                type="text" 
                class="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                :class="{'border-red-300 focus:ring-red-200': permitFormErrors.schoolYear}" 
                placeholder="YYYY-YYYY"
              />
              <p v-if="permitFormErrors.schoolYear" class="text-xs text-red-500 mt-1">{{ permitFormErrors.schoolYear }}</p>
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-700 mb-2">Levels Covered <span class="text-red-500">*</span></label>
            <div class="grid grid-cols-2 gap-2">
              <label 
                v-for="opt in levelOptions" 
                :key="opt.value" 
                class="flex items-center gap-2 p-2 rounded border cursor-pointer hover:bg-slate-50 transition-colors"
                :class="permitForm.levels.includes(opt.value) ? 'border-sky-500 bg-sky-50' : 'border-slate-200'"
              >
                <input 
                  type="checkbox" 
                  :value="opt.value" 
                  class="rounded text-sky-600 focus:ring-sky-500"
                  :checked="permitForm.levels.includes(opt.value)"
                  @change="toggleLevel(opt.value)"
                >
                <span class="text-sm text-slate-700">{{ opt.label }}</span>
              </label>
            </div>
            <p v-if="permitFormErrors.levels" class="text-xs text-red-500 mt-1">{{ permitFormErrors.levels }}</p>
          </div>

          <!-- SHS Strands -->
          <div v-if="permitForm.levels.includes('Senior High School')" class="animate-in slide-in-from-top-2 duration-300">
             <label class="block text-sm font-medium text-slate-700 mb-1">SHS Strands Detected</label>
             <div class="flex flex-wrap gap-2 p-3 bg-slate-50 rounded-lg border border-slate-200 min-h-[50px]">
                <span v-if="permitForm.strands.length === 0" class="text-sm text-slate-400 italic">No specific strands detected/selected</span>
                <span v-for="(strand, idx) in permitForm.strands" :key="idx" class="bg-white border border-slate-200 text-slate-700 text-xs px-2 py-1 rounded shadow-sm flex items-center gap-1">
                   {{ strand }}
                   <button @click="permitForm.strands.splice(idx, 1)" class="text-slate-400 hover:text-red-500"><XCircle :size="12"/></button>
                </span>
                <button class="text-xs text-sky-600 hover:underline px-2" @click="() => { const s = prompt('Add Strand (e.g. STEM):'); if(s) permitForm.strands.push(s) }">+ Add</button>
             </div>
          </div>
        </div>

        <div class="px-6 py-4 bg-slate-50 flex justify-end gap-3">
          <button @click="isRenewingPermit = false" class="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800">Cancel</button>
          <button 
            @click="async () => { const success = await submitPermit(); if(success) isRenewingPermit = false; }" 
            class="px-4 py-2 text-sm font-medium text-white bg-sky-600 rounded-lg hover:bg-sky-700 shadow-sm flex items-center gap-2"
            :disabled="ocrLoading"
          >
            <Loader2 v-if="ocrLoading" class="animate-spin" :size="16" />
            Upload Permit
          </button>
        </div>
      </div>
    </div>

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
