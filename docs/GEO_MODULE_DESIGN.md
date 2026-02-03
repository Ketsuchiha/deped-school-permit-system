# Geographic Mapping Module Design Document

## 1. Architectural Explanation

The Geographic Mapping Module (`GeoService`) is designed as a standalone, stateless service within the Node.js backend. It adheres to the **Single Responsibility Principle**, focusing solely on converting school identities (Name + Address) into precise geographic coordinates.

### Architecture Components:
-   **Input Interface**: Accepts a structured object `{ schoolName, address }`.
-   **Validator**: Enforces strict input rules before any external calls.
-   **Query Assembler**: Constructs a deterministic query string.
-   **Resolver (API Client)**: Executes the single-pass lookup to an external Geocoding API (e.g., Google Maps Platform, Mapbox).
-   **Filter & Confidence Engine**: Evaluates the returned result against strict precision criteria (`ROOFTOP` accuracy, non-administrative type).
-   **Output Interface**: Returns a standardized result object with coordinates and status.

This module is **decoupled** from the main application logic (`server.js`) and the data extraction logic (`process_permits.py`).
-   **Backend Integration**: The Node.js server calls `GeoService` when a user submits a new school or edits an address.
-   **Extraction Integration**: If Python extraction is used, the backend coordinates the flow: `Python Extract -> Backend Receive -> Backend Call GeoService -> Save to DB`. This keeps the geolocation logic centralized in one place (Node.js).

## 2. Logical Flow of Execution

1.  **Receive Input**: `resolveLocation(schoolName, address)`
2.  **Input Validation**:
    -   Sanitize: Trim whitespace, remove special characters (except `.` `,` `-` `#`).
    -   Check: Is address empty? Is it too short? Does it look like just a city name?
    -   *Action*: If invalid, return `VALIDATION_FAILURE` immediately.
3.  **Query Construction**:
    -   Format: `"${schoolName}, ${address}"`
    -   *Constraint*: No fuzzy matching parameters, no multiple variations.
4.  **External Lookup (Single-Pass)**:
    -   Call Geocoding API.
    -   *Constraint*: No retries with broader search regions.
5.  **Result Evaluation (The "Filter")**:
    -   **Check 1**: Does result have `lat` and `lng`?
    -   **Check 2**: Is `location_type` equal to `ROOFTOP` or `RANGE_INTERPOLATED`? (Reject `APPROXIMATE`, `GEOMETRIC_CENTER`).
    -   **Check 3**: Is the result type specific (e.g., `premise`, `street_address`, `establishment`)? (Reject `locality`, `administrative_area`).
6.  **Confidence Scoring**:
    -   If `ROOFTOP` -> High Confidence.
    -   If `RANGE_INTERPOLATED` -> Medium Confidence (Requires Flag).
    -   Else -> Low Confidence (Reject).
7.  **Return Output**:
    -   Success: `{ status: 'SUCCESS', lat, lng, accuracy: 'ROOFTOP', confidence: 1.0 }`
    -   Failure: `{ status: 'LOW_CONFIDENCE' | 'NO_MATCH' | 'VALIDATION_ERROR', error: '...' }`

## 3. Justification for Design Decisions

-   **Node.js Implementation**: Matches the primary backend technology, allowing for non-blocking I/O during external API calls.
-   **Strict Validation**: "Garbage in, garbage out" is prevented by rejecting ambiguous addresses (e.g., "Cabuyao City") before they reach the API, saving costs and preventing false positives.
-   **No Fallbacks**: Fallback logic (e.g., "If address fails, try city center") is the primary cause of misleading map pins. By failing explicitly, we force human intervention, which is required for the "trustworthy" objective.
-   **Single-Pass Resolution**: Prevents the system from "guessing" by widening the search radius, which often results in pinning the wrong branch of a school or a similarly named entity in a different town.

## 4. Preservation of Accuracy

Accuracy is preserved through a **Negative Selection Strategy**:
-   Instead of trying to find the *best* match among poor options, the module **rejects** all options that do not meet the `ROOFTOP` or `premise` standard.
-   **Source of Truth**: The module relies strictly on the `schoolName` paired with the `address`. It does not use the IP address of the user or the location of the device scanning the document.
-   **Manual Verification Trigger**: Any result that is not "High Confidence" triggers a `MANUAL_REVIEW` status. The system does not silently save approximate coordinates.

## 5. Integration Plan
-   **New Dependency**: `axios` (for robust HTTP requests).
-   **Configuration**: API Key must be stored in environment variables (`GEOCODING_API_KEY`).
-   **Database Update**: Add `latitude`, `longitude`, `geo_accuracy`, and `geo_status` columns to the `schools` table.
