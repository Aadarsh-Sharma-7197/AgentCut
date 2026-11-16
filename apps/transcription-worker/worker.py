#!/usr/bin/env python3
"""
AgentCut Transcription Worker
Long-lived managed Python worker communicating over stdin/stdout using JSON Lines.
All diagnostic logging is sent strictly to stderr.
"""

import sys
import os
import json
import traceback
import math
from typing import Optional, Dict, Any, List

# Add NVIDIA CUDA & cuDNN DLL directories on Windows if present
if sys.platform == "win32":
    for p in sys.path:
        nvidia_dir = os.path.join(p, "nvidia")
        if os.path.isdir(nvidia_dir):
            for sub in ["cublas", "cudnn", "cuda_nvrtc"]:
                bin_dir = os.path.join(nvidia_dir, sub, "bin")
                if os.path.isdir(bin_dir):
                    if hasattr(os, "add_dll_directory"):
                        try:
                            os.add_dll_directory(bin_dir)
                        except Exception:
                            pass
                    os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")

# Ensure stdout and stderr use UTF-8 and line buffering
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)


def log(msg: str):
    sys.stderr.write(f"[TranscriptionWorker] {msg}\n")
    sys.stderr.flush()


def send_response(response: Dict[str, Any]):
    line = json.dumps(response, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


# Global model cache to reuse model across sequential requests
_current_model = None
_current_model_key = None
_current_device = None
_current_compute_type = None


def probe_hardware() -> Dict[str, Any]:
    """Probes CTranslate2 and CUDA availability and supported compute types."""
    try:
        import ctranslate2
        import faster_whisper

        cuda_device_count = ctranslate2.get_cuda_device_count()
        cuda_available = cuda_device_count > 0

        cpu_compute_types = list(ctranslate2.get_supported_compute_types("cpu"))
        cuda_compute_types = (
            list(ctranslate2.get_supported_compute_types("cuda"))
            if cuda_available
            else []
        )

        device_name = "CPU"
        if cuda_available:
            try:
                # Optional check for device name via torch or nvidia-smi
                device_name = f"NVIDIA GPU (CUDA, {cuda_device_count} device(s))"
            except Exception:
                device_name = "NVIDIA CUDA GPU"

        return {
            "success": True,
            "cuda_available": cuda_available,
            "cuda_device_count": cuda_device_count,
            "device_name": device_name,
            "supported_compute_types_cpu": cpu_compute_types,
            "supported_compute_types_cuda": cuda_compute_types,
            "ctranslate2_version": getattr(ctranslate2, "__version__", "unknown"),
            "faster_whisper_version": getattr(faster_whisper, "__version__", "unknown"),
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to probe hardware: {str(e)}",
            "cuda_available": False,
            "cuda_device_count": 0,
            "device_name": "CPU",
            "supported_compute_types_cpu": ["int8", "float32"],
            "supported_compute_types_cuda": [],
            "ctranslate2_version": "unknown",
            "faster_whisper_version": "unknown",
        }


def get_default_download_root() -> str:
    env_dir = os.environ.get("WHISPER_MODELS_DIR") or os.environ.get("AGENTCUT_MODELS_DIR")
    if env_dir:
        return os.path.abspath(env_dir)
    data_dir = os.environ.get("AGENTCUT_DATA_DIR")
    if not data_dir:
        data_dir = os.path.join(os.path.expanduser("~"), ".agentcut")
    models_dir = os.path.join(data_dir, "models", "whisper")
    os.makedirs(models_dir, exist_ok=True)
    return models_dir


def get_model(
    model_name: str,
    device: str = "auto",
    compute_type: str = "auto",
    download_root: Optional[str] = None,
):
    """
    Loads or retrieves cached WhisperModel with hardware-aware device selection and CPU fallback.
    """
    global _current_model, _current_model_key, _current_device, _current_compute_type

    if not download_root:
        download_root = get_default_download_root()

    import ctranslate2
    from faster_whisper import WhisperModel

    cuda_count = ctranslate2.get_cuda_device_count()
    cuda_available = cuda_count > 0
    supported_cuda_types = (
        ctranslate2.get_supported_compute_types("cuda") if cuda_available else set()
    )
    supported_cpu_types = ctranslate2.get_supported_compute_types("cpu")

    # Determine desired device and compute type
    target_device = "cpu"
    target_compute = "int8"
    fallback_allowed = True

    if device == "cuda":
        if not cuda_available:
            raise RuntimeError("CUDA device requested but no CUDA-capable GPU was found.")
        target_device = "cuda"
        fallback_allowed = False
    elif device == "cpu":
        target_device = "cpu"
        fallback_allowed = False
    else:  # auto
        if cuda_available:
            target_device = "cuda"
            fallback_allowed = True
        else:
            target_device = "cpu"
            fallback_allowed = False

    # Determine compute type for target device
    if target_device == "cuda":
        if compute_type != "auto" and compute_type in supported_cuda_types:
            target_compute = compute_type
        elif "int8_float16" in supported_cuda_types:
            target_compute = "int8_float16"
        elif "float16" in supported_cuda_types:
            target_compute = "float16"
        elif "int8" in supported_cuda_types:
            target_compute = "int8"
        else:
            target_compute = "float32"
    else:
        if compute_type != "auto" and compute_type in supported_cpu_types:
            target_compute = compute_type
        elif "int8" in supported_cpu_types:
            target_compute = "int8"
        else:
            target_compute = "float32"

    cache_key = f"{model_name}:{target_device}:{target_compute}:{download_root}"

    if _current_model is not None and _current_model_key == cache_key:
        return _current_model, _current_device, _current_compute_type

    log(
        f"Loading model '{model_name}' on device '{target_device}' with compute_type '{target_compute}'..."
    )

    try:
        model = WhisperModel(
            model_name,
            device=target_device,
            compute_type=target_compute,
            download_root=download_root,
        )
        _current_model = model
        _current_model_key = cache_key
        _current_device = target_device
        _current_compute_type = target_compute
        log(f"Model '{model_name}' successfully loaded on '{target_device}' ({target_compute}).")
        return _current_model, _current_device, _current_compute_type

    except Exception as cuda_err:
        err_msg = str(cuda_err).lower()
        is_cuda_init_or_oom = (
            target_device == "cuda"
            and (
                "cuda" in err_msg
                or "cudnn" in err_msg
                or "out of memory" in err_msg
                or "cublas" in err_msg
                or "driver" in err_msg
                or "device" in err_msg
            )
        )

        if fallback_allowed and is_cuda_init_or_oom:
            log(
                f"GPU initialization/allocation failed ({cuda_err}). Falling back to CPU int8 execution."
            )
            cpu_compute = "int8" if "int8" in supported_cpu_types else "float32"
            cpu_cache_key = f"{model_name}:cpu:{cpu_compute}:{download_root}"

            model = WhisperModel(
                model_name,
                device="cpu",
                compute_type=cpu_compute,
                download_root=download_root,
            )
            _current_model = model
            _current_model_key = cpu_cache_key
            _current_device = "cpu"
            _current_compute_type = cpu_compute
            log(f"Model '{model_name}' successfully loaded on CPU fallback ({cpu_compute}).")
            return _current_model, _current_device, _current_compute_type
        else:
            raise cuda_err


def transcribe_audio(
    audio_path: str,
    model_name: str = "small",
    language: Optional[str] = None,
    device: str = "auto",
    compute_type: str = "auto",
    word_timestamps: bool = True,
    download_root: Optional[str] = None,
) -> Dict[str, Any]:
    """Transcribes an audio WAV file using Faster-Whisper and returns structured segments and metadata."""
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    model, actual_device, actual_compute = get_model(
        model_name=model_name,
        device=device,
        compute_type=compute_type,
        download_root=download_root,
    )

    log(f"Transcribing '{audio_path}' (model={model_name}, lang={language}, device={actual_device})...")

    # Transcription parameters
    # vad_filter: filters out non-speech silence cleanly
    # word_timestamps: word level timestamps
    # task: strictly "transcribe" (never translate)
    try:
        segments_iter, info = model.transcribe(
            audio_path,
            language=language if language and language != "auto" else None,
            task="transcribe",
            beam_size=5,
            word_timestamps=word_timestamps,
            vad_filter=True,
        )
        seg_list = list(segments_iter)
    except Exception as infer_err:
        err_msg = str(infer_err).lower()
        is_cuda_err = (
            actual_device == "cuda"
            and (
                "cuda" in err_msg
                or "cudnn" in err_msg
                or "out of memory" in err_msg
                or "cublas" in err_msg
                or "driver" in err_msg
                or "device" in err_msg
            )
        )
        if is_cuda_err and (device == "auto" or device == "cuda"):
            log(f"Inference on CUDA failed with ({infer_err}). Falling back to CPU int8 inference...")
            cpu_model, actual_device, actual_compute = get_model(
                model_name=model_name,
                device="cpu",
                compute_type="int8",
                download_root=download_root,
            )
            segments_iter, info = cpu_model.transcribe(
                audio_path,
                language=language if language and language != "auto" else None,
                task="transcribe",
                beam_size=5,
                word_timestamps=word_timestamps,
                vad_filter=True,
            )
            seg_list = list(segments_iter)
        else:
            raise infer_err

    detected_lang = info.language
    lang_prob = round(info.language_probability, 4) if hasattr(info, "language_probability") and info.language_probability is not None else None
    duration = round(info.duration, 3) if hasattr(info, "duration") and info.duration is not None else 0.0

    segments: List[Dict[str, Any]] = []
    full_text_parts: List[str] = []

    seg_id = 0
    for seg in seg_list:
        text = seg.text.strip()
        if not text:
            continue

        start = round(max(0.0, float(seg.start)), 3)
        end = round(max(start, float(seg.end)), 3)

        # Clamping sanity check against duration if duration is positive
        if duration > 0:
            end = min(end, round(duration + 0.5, 3))

        words = []
        if word_timestamps and hasattr(seg, "words") and seg.words:
            for w in seg.words:
                w_text = w.word.strip()
                if w_text:
                    words.append(
                        {
                            "word": w_text,
                            "start": round(max(0.0, float(w.start)), 3),
                            "end": round(max(float(w.start), float(w.end)), 3),
                            "probability": round(float(w.probability), 4)
                            if hasattr(w, "probability") and w.probability is not None
                            else None,
                        }
                    )

        segments.append(
            {
                "id": seg_id,
                "start": start,
                "end": end,
                "text": text,
                "words": words if words else None,
            }
        )
        full_text_parts.append(text)
        seg_id += 1

    full_text = " ".join(full_text_parts)

    return {
        "success": True,
        "language": detected_lang,
        "language_probability": lang_prob,
        "duration": duration,
        "segment_count": len(segments),
        "segments": segments,
        "text": full_text,
        "execution_device": actual_device,
        "compute_type": actual_compute,
        "model_name": model_name,
    }


def handle_request(req: Dict[str, Any]) -> Dict[str, Any]:
    req_id = req.get("id")
    req_type = req.get("type")

    if not req_type:
        return {"id": req_id, "success": False, "error": "Missing 'type' in request"}

    if req_type == "ping":
        return {"id": req_id, "type": "pong", "success": True}

    elif req_type == "probe":
        probe_res = probe_hardware()
        probe_res["id"] = req_id
        probe_res["type"] = "probe"
        return probe_res

    elif req_type == "load_model":
        model_name = req.get("model_name", "small")
        device = req.get("device", "auto")
        compute_type = req.get("compute_type", "auto")
        download_root = req.get("download_root")

        try:
            _, actual_device, actual_compute = get_model(
                model_name=model_name,
                device=device,
                compute_type=compute_type,
                download_root=download_root,
            )
            return {
                "id": req_id,
                "type": "load_model",
                "success": True,
                "model_name": model_name,
                "execution_device": actual_device,
                "compute_type": actual_compute,
            }
        except Exception as e:
            err_msg = str(e)
            can_retry_cpu = (
                device == "cuda"
                and any(
                    term in err_msg.lower()
                    for term in ["cuda", "cudnn", "memory", "driver"]
                )
            )
            return {
                "id": req_id,
                "type": "load_model",
                "success": False,
                "error": err_msg,
                "can_retry_cpu": can_retry_cpu,
            }

    elif req_type == "transcribe":
        audio_path = req.get("audio_path")
        if not audio_path:
            return {
                "id": req_id,
                "type": "transcribe",
                "success": False,
                "error": "Missing 'audio_path' parameter.",
            }

        model_name = req.get("model_name", "small")
        language = req.get("language")
        device = req.get("device", "auto")
        compute_type = req.get("compute_type", "auto")
        word_timestamps = req.get("word_timestamps", True)
        download_root = req.get("download_root")

        try:
            result = transcribe_audio(
                audio_path=audio_path,
                model_name=model_name,
                language=language,
                device=device,
                compute_type=compute_type,
                word_timestamps=word_timestamps,
                download_root=download_root,
            )
            result["id"] = req_id
            result["type"] = "transcribe"
            return result
        except Exception as e:
            err_msg = str(e)
            log(f"Transcription error for request {req_id}: {err_msg}")
            log(traceback.format_exc())
            can_retry_cpu = (
                device == "cuda"
                and any(
                    term in err_msg.lower()
                    for term in ["cuda", "cudnn", "memory", "driver"]
                )
            )
            return {
                "id": req_id,
                "type": "transcribe",
                "success": False,
                "error": err_msg,
                "can_retry_cpu": can_retry_cpu,
            }

    elif req_type == "exit":
        log("Received exit request. Shutting down worker.")
        send_response({"id": req_id, "type": "exit", "success": True})
        sys.exit(0)

    else:
        return {
            "id": req_id,
            "type": req_type,
            "success": False,
            "error": f"Unknown request type '{req_type}'",
        }


def main():
    log("Transcription worker process initialized. Waiting for stdin requests...")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except Exception as json_err:
            log(f"Invalid JSON received on stdin: {line[:100]}... Error: {json_err}")
            send_response(
                {
                    "id": None,
                    "type": "error",
                    "success": False,
                    "error": f"Malformed JSON line: {str(json_err)}",
                }
            )
            continue

        try:
            resp = handle_request(req)
            send_response(resp)
        except Exception as unhandled:
            log(f"Unhandled exception while processing request: {unhandled}")
            log(traceback.format_exc())
            send_response(
                {
                    "id": req.get("id"),
                    "type": req.get("type", "unknown"),
                    "success": False,
                    "error": f"Internal worker error: {str(unhandled)}",
                }
            )


if __name__ == "__main__":
    main()
