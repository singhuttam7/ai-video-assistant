# AI Video Assistant

An AI-powered Video Assistant that converts videos into transcripts, summaries, action items, key decisions, and provides an interactive RAG-based chat.

Features
🎥 YouTube URL or local video/audio input
📝 Whisper-based transcription
🤖 Mistral AI summarization
✅ Action items extraction
🔑 Key decisions extraction
❓ Open questions extraction
💬 RAG-based chat with the video
🗃️ ChromaDB vector storage
🌐 FastAPI backend and web frontend
Tech Stack

Python • FastAPI • Whisper • Mistral AI • LangChain • ChromaDB • FFmpeg • HTML • CSS • JavaScript

Installation
pip install -r requirements.txt

Create a .env file:

MISTRAL_API_KEY=your_mistral_api_key
SARVAM_API_KEY=your_sarvam_api_key
Run
uvicorn server:app --reload

Open:

http://localhost:8000
Project Structure
Video_Agent/
├── core/
├── utils/
├── frontend/
├── uploads/
├── downloads/
├── vector_db/
├── server.py
├── main.py
└── requirements.txt
