from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
import os
import uuid
import json
import sqlite3
import datetime
import aiofiles
import logging
from sqlalchemy import create_engine, Column, String, Integer, DateTime, ForeignKey, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Database Setup
DATABASE_URL = "sqlite:///./school_permits.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Models
class SchoolModel(Base):
    __tablename__ = "schools"
    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    type = Column(String, nullable=False)
    address = Column(String)
    operationalStatus = Column(String, default="Operational")
    deleted = Column(Integer, default=0)
    deletedAt = Column(DateTime, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    geo_accuracy = Column(String, nullable=True)
    geo_status = Column(String, nullable=True)

class PermitModel(Base):
    __tablename__ = "permits"
    id = Column(String, primary_key=True, index=True)
    schoolId = Column(String, ForeignKey("schools.id"))
    levels = Column(String)  # JSON string
    schoolYear = Column(String)
    permitNumber = Column(String)
    extractedText = Column(String)
    filePath = Column(String)
    localFilePath = Column(String)
    fileName = Column(String)
    createdAt = Column(DateTime, default=datetime.datetime.utcnow)
    deleted = Column(Integer, default=0)
    deletedAt = Column(DateTime, nullable=True)

class AuditLogModel(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    action = Column(String)
    details = Column(String)
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)

Base.metadata.create_all(bind=engine)

# FastAPI App
app = FastAPI(title="School Permit Registry API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Uploads directory
UPLOAD_DIR = "uploads"
if not os.path.exists(UPLOAD_DIR):
    os.makedirs(UPLOAD_DIR)

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Schemas
class SchoolBase(BaseModel):
    id: str
    name: str
    type: str
    address: Optional[str] = None
    operationalStatus: Optional[str] = "Operational"

class SchoolCreate(SchoolBase):
    pass

from pydantic import BaseModel, ConfigDict

class SchoolResponse(SchoolBase):
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    geo_accuracy: Optional[str] = None
    geo_status: Optional[str] = None
    deleted: int
    
    model_config = ConfigDict(from_attributes=True)

class PermitResponse(BaseModel):
    id: str
    schoolId: str
    levels: List[str]
    schoolYear: str
    permitNumber: str
    extractedText: Optional[str] = None
    filePath: Optional[str] = None
    fileName: Optional[str] = None
    createdAt: datetime.datetime
    deleted: int
    filePreviewUrl: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)

# API Endpoints
@app.get("/api/schools", response_model=List[SchoolResponse])
def get_schools(db: Session = Depends(get_db)):
    schools = db.query(SchoolModel).filter(SchoolModel.deleted == 0).all()
    return schools

@app.post("/api/schools", response_model=SchoolResponse)
async def create_school(school: SchoolCreate, db: Session = Depends(get_db)):
    # Note: GeoService porting would go here
    db_school = SchoolModel(**school.dict(), deleted=0)
    db.add(db_school)
    db.commit()
    db.refresh(db_school)
    return db_school

@app.get("/api/permits", response_model=List[PermitResponse])
def get_permits(db: Session = Depends(get_db)):
    permits = db.query(PermitModel).filter(PermitModel.deleted == 0).all()
    results = []
    for p in permits:
        p_dict = {c.name: getattr(p, c.name) for c in p.__table__.columns}
        p_dict['levels'] = json.loads(p.levels or '[]')
        p_dict['filePreviewUrl'] = p.filePath
        results.append(p_dict)
    return results

@app.post("/api/permits")
async def create_permit(
    id: str = Form(...),
    schoolId: str = Form(...),
    levels: str = Form(...),
    schoolYear: str = Form(...),
    permitNumber: str = Form(...),
    extractedText: str = Form(...),
    file: UploadFile = File(None),
    db: Session = Depends(get_db)
):
    file_url = None
    file_path = None
    original_name = None

    if file:
        unique_filename = f"{int(datetime.datetime.now().timestamp())}-{uuid.uuid4().hex[:8]}{os.path.splitext(file.filename)[1]}"
        file_path = os.path.join(UPLOAD_DIR, unique_filename)
        async with aiofiles.open(file_path, 'wb') as out_file:
            content = await file.read()
            await out_file.write(content)
        
        file_url = f"http://localhost:3000/uploads/{unique_filename}"
        original_name = file.filename

    db_permit = PermitModel(
        id=id,
        schoolId=schoolId,
        levels=levels,
        schoolYear=schoolYear,
        permitNumber=permitNumber,
        extractedText=extractedText,
        filePath=file_url,
        localFilePath=file_path,
        fileName=original_name,
        deleted=0
    )
    db.add(db_permit)
    db.commit()
    db.refresh(db_permit)
    
    # Audit log
    audit = AuditLogModel(action="UPLOAD_PERMIT", details=json.dumps({
        "schoolId": schoolId,
        "permitNumber": permitNumber,
        "schoolYear": schoolYear,
        "fileName": original_name
    }))
    db.add(audit)
    db.commit()

    return {
        "id": id,
        "schoolId": schoolId,
        "levels": json.loads(levels or '[]'),
        "schoolYear": schoolYear,
        "permitNumber": permitNumber,
        "extractedText": extractedText,
        "filePreviewUrl": file_url,
        "fileName": original_name,
        "deleted": 0
    }

@app.get("/api/trash")
def get_trash(db: Session = Depends(get_db)):
    schools = db.query(SchoolModel).filter(SchoolModel.deleted == 1).all()
    permits = db.query(PermitModel).filter(PermitModel.deleted == 1).all()
    return {
        "schools": schools,
        "permits": permits
    }

@app.put("/api/schools/{school_id}", response_model=SchoolResponse)
def update_school(school_id: str, school_data: SchoolCreate, db: Session = Depends(get_db)):
    db_school = db.query(SchoolModel).filter(SchoolModel.id == school_id).first()
    if not db_school:
        raise HTTPException(status_code=404, detail="School not found")
    
    for key, value in school_data.dict().items():
        setattr(db_school, key, value)
    
    db.commit()
    db.refresh(db_school)
    return db_school

@app.delete("/api/schools/{school_id}")
def soft_delete_school(school_id: str, db: Session = Depends(get_db)):
    db_school = db.query(SchoolModel).filter(SchoolModel.id == school_id).first()
    if not db_school:
        raise HTTPException(status_code=404, detail="School not found")
    
    now = datetime.datetime.utcnow()
    db_school.deleted = 1
    db_school.deletedAt = now
    
    # Soft delete permits
    db.query(PermitModel).filter(PermitModel.schoolId == school_id).update({
        "deleted": 1,
        "deletedAt": now
    })
    
    db.commit()
    return {"message": "School and associated permits moved to trash"}

@app.post("/api/trash/restore/{item_type}/{item_id}")
def restore_item(item_type: str, item_id: str, db: Session = Depends(get_db)):
    if item_type == 'school':
        db_school = db.query(SchoolModel).filter(SchoolModel.id == item_id).first()
        if db_school:
            db_school.deleted = 0
            db_school.deletedAt = None
            # Also restore its permits
            db.query(PermitModel).filter(PermitModel.schoolId == item_id).update({
                "deleted": 0,
                "deletedAt": None
            })
    elif item_type == 'permit':
        db_permit = db.query(PermitModel).filter(PermitModel.id == item_id).first()
        if db_permit:
            db_permit.deleted = 0
            db_permit.deletedAt = None
            
    db.commit()
    return {"status": "restored"}

@app.delete("/api/trash/forever/{item_type}/{item_id}")
def delete_forever(item_type: str, item_id: str, db: Session = Depends(get_db)):
    if item_type == 'school':
        db.query(SchoolModel).filter(SchoolModel.id == item_id).delete()
        db.query(PermitModel).filter(PermitModel.schoolId == item_id).delete()
    elif item_type == 'permit':
        db.query(PermitModel).filter(PermitModel.id == item_id).delete()
        
    db.commit()
    return {"status": "deleted_forever"}

import httpx
import csv
import io
from fastapi.responses import Response

@app.get("/api/geocode")
async def geocode(q: str):
    async with httpx.AsyncClient() as client:
        # Using Photon (OpenStreetMap) for geocoding
        url = f"https://photon.komoot.io/api/?q={q}&lat=14.277&lon=121.123"
        response = await client.get(url)
        return response.json()

@app.get("/api/reverse-geocode")
async def reverse_geocode(lat: float, lon: float):
    async with httpx.AsyncClient() as client:
        url = f"https://photon.komoot.io/reverse?lat={lat}&lon={lon}"
        response = await client.get(url)
        data = response.json()
        
        if data.get('features'):
            feat = data['features'][0]['properties']
            addr_parts = []
            if feat.get('name'): addr_parts.append(feat['name'])
            if feat.get('street'): addr_parts.append(feat['street'])
            if feat.get('district'): addr_parts.append(feat['district'])
            if feat.get('city'): addr_parts.append(feat['city'])
            return {"status": "SUCCESS", "address": ", ".join(addr_parts)}
            
        return {"status": "FAILED", "address": ""}

@app.get("/api/reports/permits")
def get_permit_report(year: Optional[str] = None, db: Session = Depends(get_db)):
    query = db.query(PermitModel, SchoolModel).join(SchoolModel, PermitModel.schoolId == SchoolModel.id)
    query = query.filter(PermitModel.deleted == 0, SchoolModel.deleted == 0)
    
    if year and len(year) == 4:
        query = query.filter(PermitModel.schoolYear.like(f"%{year}%"))
    else:
        # Default: 2018-present
        query = query.filter(PermitModel.schoolYear >= "2018")
        
    rows = query.order_by(PermitModel.schoolYear, SchoolModel.name).all()
    
    output = []
    headers = [
      'Permit ID', 'School ID', 'School Name', 'School Type', 'School Address',
      'Permit Number', 'School Year', 'Levels', 'File Name', 'Geo Status', 'Geo Accuracy'
    ]
    output.append(headers)
    
    for p, s in rows:
        levels_str = ""
        try:
            levels_arr = json.loads(p.levels or '[]')
            levels_str = "; ".join(levels_arr)
        except:
            levels_str = p.levels
            
        output.append([
            p.id, s.id, s.name, s.type, s.address,
            p.permitNumber, p.schoolYear, levels_str, p.fileName,
            s.geo_status, s.geo_accuracy
        ])
        
    si = io.StringIO()
    cw = csv.writer(si)
    cw.writerows(output)
    
    label_year = year if year and len(year) == 4 else "2018-present"
    return Response(
        content=si.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=permits-summary-{label_year}.csv"}
    )

@app.get("/api/maps/proxy/{z}/{x}/{y}")
async def map_proxy(z: int, x: int, y: int):
    async with httpx.AsyncClient() as client:
        url = f"https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        headers = {"User-Agent": "SchoolPermitRegistry/1.0"}
        response = await client.get(url, headers=headers)
        return Response(content=response.content, media_type="image/png")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
