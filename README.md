# Deped School Permit System

A web application for managing school permits for the Department of Education (DepED).

## Project Structure

```
├── backend/              # Node.js backend server
│   ├── server.js        # Express server configuration
│   ├── package.json     # Backend dependencies
│   └── uploads/         # Directory for uploaded files
├── src/                 # Vue.js frontend source
│   ├── components/      # Vue components
│   ├── App.vue          # Root Vue component
│   ├── main.js          # Vue application entry point
│   └── index.css        # Global styles
├── index.html           # HTML entry point
├── package.json         # Frontend dependencies
├── vite.config.js       # Vite configuration
├── tailwind.config.js   # Tailwind CSS configuration
└── postcss.config.js    # PostCSS configuration
```

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn

## Installation

### 1. Install Frontend Dependencies

```bash
npm install
```

### 2. Install Backend Dependencies

```bash
cd backend
npm install
cd ..
```

## Running the Application

### Start the Backend Server

Open a terminal and run:

```bash
cd backend
node server.js
```

The backend server will start on `http://localhost:3000` (or the port specified in your `server.js` file).

### Start the Frontend Development Server

Open another terminal and run:

```bash
npm run dev
```

The frontend development server will typically start on `http://localhost:5173`.

## Building for Production

### Frontend Build

```bash
npm run build
```

This generates optimized production files in the `dist/` directory.

### Backend Production

For production deployment, ensure the backend environment is properly configured and run:

```bash
cd backend
node server.js
```

## Technologies Used

- **Frontend:**
  - Vue.js 3
  - Vite
  - Tailwind CSS
  - PostCSS

- **Backend:**
  - Node.js
  - Express.js

## Features

- School permit management
- File uploads
- Form validation with CustomSelect component
- Responsive design with Tailwind CSS

## Development

For development, both servers should run simultaneously:
- Frontend on `http://localhost:5173`
- Backend on `http://localhost:3000`

Ensure your frontend is configured to make API calls to the correct backend URL.

## License

Please specify your license here.

## Author

Ketsuchiha
