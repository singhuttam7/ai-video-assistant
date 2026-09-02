"""
server.py
---------
FastAPI layer around the existing AI Video Assistant pipeline (main.py).

It does not change any pipeline logic. It calls the exact same functions
main.py calls, one at a time, so the UI can show real, live progress for
each stage instead of a fake spinner.

Run with:
    uvicorn server:app --reload --port 8000

Then open http://localhost:8000 in a browser.
"""

import os
import time
import uuid
import shutil
import threading
import traceback
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

# --- Same imports main.py uses. Keep your existing core/ and utils/ packages
# --- next to this file and main.py; nothing in them needs to change.
from utils.audio_processor import process_input
from core.transcriber import transcribe_all
from core.summarizer import summarize, generate_title
from core.extractor import extract_action_items, extract_key_decisions, extract_questions
from core.rag_engine import build_rag_chain, ask_question

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = FastAPI(title="AI Video Assistant API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------
# Each job looks like:
# {
#   "status": "queued" | "running" | "done" | "error",
#   "stage": "ingest" | "transcribe" | "title" | "summarize" | "extract" | "rag",
#   "progress": 0-100,
#   "message": "Human readable current step",
#   "started_at": float,
#   "elapsed": float,
#   "error": str | None,
#   "result": {...} | None,   # everything except the rag_chain object
#   "rag_chain": object | None,
# }
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()

# Stage plan: (key, label, weight-of-total-progress)
STAGES = [
    ("ingest", "Reading and chunking the source", 10),
    ("transcribe", "Transcribing audio", 40),
    ("title", "Generating a title", 5),
    ("summarize", "Summarizing the content", 20),
    ("extract", "Extracting action items, decisions and questions", 15),
    ("rag", "Preparing the chat assistant", 10),
]


def _set_job(job_id: str, **kwargs):
    with JOBS_LOCK:
        JOBS[job_id].update(kwargs)
        if "started_at" in JOBS[job_id]:
            JOBS[job_id]["elapsed"] = round(time.time() - JOBS[job_id]["started_at"], 1)


def _progress_for(stage_key: str) -> int:
    total = 0
    for key, _label, weight in STAGES:
        if key == stage_key:
            return total
        total += weight
    return 100


def _run_pipeline_job(job_id: str, source: str, language: str):
    try:
        _set_job(job_id, status="running")

        # 1. Ingest
        _set_job(job_id, stage="ingest", progress=_progress_for("ingest"),
                  message=STAGES[0][1])
        chunks = process_input(source)

        # 2. Transcribe
        _set_job(job_id, stage="transcribe", progress=_progress_for("transcribe"),
                  message=STAGES[1][1])
        transcript = transcribe_all(chunks, language=language)

        # 3. Title
        _set_job(job_id, stage="title", progress=_progress_for("title"),
                  message=STAGES[2][1])
        title = generate_title(transcript)

        # 4. Summarize
        _set_job(job_id, stage="summarize", progress=_progress_for("summarize"),
                  message=STAGES[3][1])
        summary = summarize(transcript)

        # 5. Extract
        _set_job(job_id, stage="extract", progress=_progress_for("extract"),
                  message=STAGES[4][1])
        action_items = extract_action_items(transcript)
        decisions = extract_key_decisions(transcript)
        questions = extract_questions(transcript)

        # 6. RAG
        _set_job(job_id, stage="rag", progress=_progress_for("rag"),
                  message=STAGES[5][1])
        rag_chain = build_rag_chain(transcript)

        result = {
            "title": title,
            "transcript": transcript,
            "summary": summary,
            "action_items": action_items,
            "key_decisions": decisions,
            "open_questions": questions,
        }

        _set_job(
            job_id,
            status="done",
            stage="ready",
            progress=100,
            message="Ready",
            result=result,
            rag_chain=rag_chain,
        )

    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        _set_job(job_id, status="error", message="Something went wrong", error=str(exc))


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------
class ChatRequest(BaseModel):
    question: str


class ChatResponse(BaseModel):
    answer: str


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/jobs")
def create_job(
    language: str = Form("english"),
    url: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
):
    if not url and not file:
        raise HTTPException(status_code=400, detail="Provide a video link or a file.")

    if file:
        ext = os.path.splitext(file.filename or "")[1] or ".mp4"
        saved_name = f"{uuid.uuid4().hex}{ext}"
        saved_path = os.path.join(UPLOAD_DIR, saved_name)
        with open(saved_path, "wb") as out:
            shutil.copyfileobj(file.file, out)
        source = saved_path
    else:
        source = url.strip()

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "message": "Queued",
            "started_at": time.time(),
            "elapsed": 0,
            "error": None,
            "result": None,
            "rag_chain": None,
            "source_label": file.filename if file else source,
        }

    thread = threading.Thread(
        target=_run_pipeline_job, args=(job_id, source, language), daemon=True
    )
    thread.start()

    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}/status")
def job_status(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return {
            "status": job["status"],
            "stage": job["stage"],
            "progress": job["progress"],
            "message": job["message"],
            "elapsed": job["elapsed"],
            "error": job["error"],
            "source_label": job.get("source_label"),
            "stages": [{"key": k, "label": l} for k, l, _w in STAGES],
        }


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job["status"] != "done":
            raise HTTPException(status_code=409, detail="Job is not finished yet")
        return job["result"]


@app.post("/api/jobs/{job_id}/chat", response_model=ChatResponse)
def job_chat(job_id: str, payload: ChatRequest):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job["status"] != "done" or job["rag_chain"] is None:
            raise HTTPException(status_code=409, detail="Assistant is not ready yet")
        rag_chain = job["rag_chain"]

    if not payload.question.strip():
        raise HTTPException(status_code=400, detail="Question is empty")

    answer = ask_question(rag_chain, payload.question.strip())
    return {"answer": answer}


# ---------------------------------------------------------------------------
# Frontend (static files)
# ---------------------------------------------------------------------------
app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIR, "assets")), name="assets")
app.mount("/css", StaticFiles(directory=os.path.join(FRONTEND_DIR, "css")), name="css")
app.mount("/js", StaticFiles(directory=os.path.join(FRONTEND_DIR, "js")), name="js")


@app.get("/")
def index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
