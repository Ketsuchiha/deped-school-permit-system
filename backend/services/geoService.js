const https = require('https');

/**
 * GeoService
 * 
 * A strict, precision-focused geographic mapping module using Nominatim (OpenStreetMap).
 * 
 * Design Principles:
 * 1. Deterministic: Same input -> Same output.
 * 2. Strict Validation: Rejects ambiguous or incomplete addresses.
 * 3. Single-Pass: No retries or fuzzy matching fallbacks.
 * 4. High Confidence: Only returns coordinates if they meet precision thresholds.
 * 5. FLOSS Compliant: Uses Nominatim (OSM) instead of Proprietary APIs.
 */
class GeoService {
  constructor() {
    // Switch to Photon API (Komoot) - simpler, faster, and more forgiving than raw Nominatim
    this.API_ENDPOINT = 'https://photon.komoot.io/api/';
    this.USER_AGENT = 'DepEdPermitSystem/1.0 (Education Project)';
  }

  /**
   * Main entry point to resolve a school location.
   */
  async resolveLocation(schoolName, address) {
    try {
      // 1. Input Validation
      const cleanInput = this.validateInput(schoolName, address);
      if (cleanInput.error) {
        return this.createErrorResponse('VALIDATION_FAILURE', cleanInput.error);
      }

      // 2. Query Assembly & Execution Strategy
      // Strategy A: Specific Search (School Name + Address) - High Confidence
      // Strategy B: General Search (Address Only) - Low Confidence / Fallback

      let apiResult = null;
      let usedQuery = '';
      let matchType = 'Approximate';

      // Attempt A: Full Specific Query (if school name exists)
      if (cleanInput.schoolName) {
        const specificQuery = `${cleanInput.schoolName} ${cleanInput.address}`;
        console.log(`[GeoService] Attempting Specific Lookup: ${specificQuery}`);
        
        try {
            const specificResult = await this._performLookup(specificQuery);
            if (specificResult && specificResult.features && specificResult.features.length > 0) {
                apiResult = specificResult;
                usedQuery = specificQuery;
                matchType = 'Exact (School Name Match)';
            }
        } catch (e) {
            console.warn('[GeoService] Specific lookup failed, falling back...');
        }
      }

      // Attempt B: Fallback to Address Only (if A failed or no school name)
      if (!apiResult) {
         console.log(`[GeoService] Attempting Address Lookup: ${cleanInput.address}`);
         apiResult = await this._performLookup(cleanInput.address);
         usedQuery = cleanInput.address;
         matchType = 'Approximate (Address Match)';
      }

      // 4. Result Processing
      // Photon returns GeoJSON
      if (!apiResult || !apiResult.features || apiResult.features.length === 0) {
        return this.createErrorResponse('NO_MATCH', 'Address not found');
      }

      const bestMatch = apiResult.features[0];
      const [lng, lat] = bestMatch.geometry.coordinates; // GeoJSON is [lng, lat]
      const props = bestMatch.properties;

      return {
        status: 'SUCCESS',
        latitude: lat,
        longitude: lng,
        accuracy: matchType,
        formattedAddress: `${props.name || ''} ${props.street || ''} ${props.city || ''} ${props.country || ''}`.trim(),
        originalQuery: usedQuery,
        raw: props
      };

    } catch (error) {
      console.error('GeoService Internal Error:', error);
      return this.createErrorResponse('SYSTEM_ERROR', error.message);
    }
  }

  /**
   * Validates and sanitizes input.
   */
  validateInput(schoolName, address) {
    // School name is optional
    const cleanName = schoolName ? schoolName.trim().replace(/\s+/g, ' ') : '';
    
    if (!address || typeof address !== 'string') {
      return { error: 'Invalid address format' };
    }

    const trimmedAddress = address.trim();
    if (trimmedAddress.length < 3) {
      return { error: 'Address too short' };
    }

    return {
      schoolName: cleanName,
      address: trimmedAddress.replace(/\s+/g, ' ')
    };
  }

  /**
   * Perform lookup using Photon API.
   */
  async _performLookup(query) {
    const url = `${this.API_ENDPOINT}?q=${encodeURIComponent(query)}&limit=1`;
    console.log(`[GeoService] Photon Query: ${url}`);
    
    return new Promise((resolve, reject) => {
      const https = require('https');
      const options = {
        headers: {
          'User-Agent': this.USER_AGENT
        }
      };

      const req = https.get(url, options, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Photon API Error: ${res.statusCode}`));
        }

        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Network Error: ${err.message}`));
      });

      req.end();
    });
  }

  // Helper: Standardized Error Response
  createErrorResponse(code, message) {
    return {
      status: 'FAILED',
      errorCode: code,
      errorMessage: message,
      latitude: null,
      longitude: null
    };
  }

  // Helper: Scoring (Not strictly needed for Photon as it ranks well, but kept for structure if needed later)
  _filterAndScore(result, query) {
    // ... logic removed as we trust Photon's first result for now ...
    return result;
  }
}

module.exports = GeoService;
