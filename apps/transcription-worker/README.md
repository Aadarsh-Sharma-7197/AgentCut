# AgentCut Transcription Worker

The AgentCut Transcription Worker is a dedicated Python sub-process that performs local, privacy-preserving, multilingual audio speech-to-text analysis using [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (powered by CTranslate2).

---

## 1. Architecture & IPC Protocol

- **Managed Process Lifecycle**: The Node.js server (`apps/server`) spawns and monitors the Python worker process via `transcription-worker.service.ts`.
- **JSON Lines IPC**: Communication between Node.js and Python occurs over `stdin` and `stdout` using single-line JSON requests and responses.
- **Diagnostic Isolation**: Informational, warning, and debug logs are routed strictly to `stderr` so they never corrupt the structured stdout JSON stream.
- **Request-Response ID Matching**: Every request includes a unique `id` and `type` (`ping`, `probe`, `load_model`, `transcribe`, `exit`), matched synchronously or asynchronously by the manager.

---

## 2. Environment Setup & Windows Virtual Environment

### Prerequisites
- Python 3.10 or higher (Python 3.10.7+ verified)
- Windows PowerShell or CMD

### Creating the Virtual Environment
From the repository root:

```powershell
# Navigate to the transcription worker directory
cd apps/transcription-worker

# Create the dedicated virtual environment
python -m venv .venv

# Activate the virtual environment (Windows PowerShell)
.\.venv\Scripts\Activate.ps1

# Upgrade pip
python -m pip install --upgrade pip

# Install required dependencies
pip install -r requirements.txt
```

### Dependency Manifest (`requirements.txt`)
- `faster-whisper==1.1.1` — Optimized Whisper inference with CTranslate2 backend.
- `ctranslate2>=4.4.0` — Fast inference engine supporting CUDA 12.x and CPU vectorization.
- `requests>=2.28.0` — Required by HuggingFace Hub utilities in faster-whisper.
- `nvidia-cublas-cu12>=12.1.0` (Windows) — Bundled cuBLAS runtime DLLs (`cublas64_12.dll`).
- `nvidia-cudnn-cu12>=9.0.0` (Windows) — Bundled cuDNN runtime DLLs (`cudnn64_9.dll`).

---

## 3. Hardware Awareness & NVIDIA GPU Recommendations

### Target Hardware Profile
- **CPU**: Intel Core i5 (vectorized integer operations supported)
- **System RAM**: 16 GB
- **GPU**: NVIDIA GeForce GTX 1650 (4 GB VRAM)
- **CUDA**: CUDA 12.x / cuDNN 9.x

### Compute Types & VRAM Budgeting
- **CUDA Device Preference**: For 4 GB VRAM cards (e.g., GTX 1650), use compute type `int8_float16` by default. This quantizes model weights to 8-bit integers while performing matrix accumulations in half-precision float (FP16), reducing VRAM usage under 1.5 GB for the `small` model.
- **CPU Fallback**: If CUDA initialization fails, CUDA is absent, or CUDA throws an Out-Of-Memory (OOM) error, the worker automatically falls back to CPU execution using `int8` quantization. The API and database records accurately reflect the actual device (`cuda` or `cpu`) and compute type used.

---

## 4. Model Cache Directory (`WHISPER_MODELS_DIR`)

Models are loaded from a persistent local cache directory.

- **Default Location**: `<AGENTCUT_DATA_DIR>/models/whisper` (typically `C:\Users\<username>\.agentcut\models\whisper`)
- **Custom Location**: Configure the `WHISPER_MODELS_DIR` or `AGENTCUT_MODELS_DIR` environment variable.
- **Supported Models**: `small` (default) and `base`.
- **Offline Guarantee**: When model weights exist in the cache directory, faster-whisper runs in `local_files_only=True` mode, requiring zero internet access.

---

## 5. Non-Destructive Media Intelligence Guarantees

1. **Source Media Untouched**: The transcription worker never touches or modifies original imported media files.
2. **Extracted Audio Dependency**: Transcription operates exclusively on 16 kHz mono 16-bit PCM WAV artifacts (`audio.wav`) generated during Audio Extraction (Step 5.1).
3. **Atomic Persistence**: Transcripts are written atomically to a temporary file (`transcript.<id>.tmp.json`) and renamed to `transcript.json` upon complete validation.
4. **Metadata Isolation**: Project deletion deletes only database metadata records; physical video assets, extracted audio, and transcript files are preserved.
