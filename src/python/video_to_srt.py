import argparse
import json
import sys
import os
import platform
import subprocess
import tempfile
import shutil # Added for shutil.which
import torch # Added for device check
import gc
import whisperx
import io # Added for StringIO
from funasr import AutoModel
import resource # For setting memory limits

memory_limit_gb = 24
soft, hard = resource.getrlimit(resource.RLIMIT_AS)
resource.setrlimit(resource.RLIMIT_AS, (memory_limit_gb * 1024**3, hard))

# Keep str_to_bool and format_timestamp as they are useful
def str_to_bool(value):
   if isinstance(value, bool):
       return value
   if value.lower() in ('yes', 'true', 't', 'y', '1'):
       return True
   elif value.lower() in ('no', 'false', 'f', 'n', '0'):
       return False
   else:
       raise argparse.ArgumentTypeError('Boolean value expected.')

def milliseconds_to_srt_time_format(milliseconds: int) -> str:
    """Converts milliseconds to HH:MM:SS,mmm SRT time format."""
    if not isinstance(milliseconds, (int, float)) or milliseconds < 0:
        # Consider adding logging if a logger is set up in this script
        return "00:00:00,000"
    seconds, ms = divmod(int(milliseconds), 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{int(hours):02d}:{int(minutes):02d}:{int(seconds):02d},{int(ms):03d}"

def cleanup_model(model, device: str):
    """
    Helper function to consolidate repeated garbage collection and model unloading logic.
    
    Args:
        model: The model object to clean up
        device: The device the model was running on ("cuda" or "cpu")
    """
    if model:
        del model
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()

def get_ffmpeg_path():
    """Determines the path to the ffmpeg executable by checking the system PATH."""
    ffmpeg_exe_name = "ffmpeg.exe" if platform.system() == "Windows" else "ffmpeg"
    
    ffmpeg_in_path = shutil.which(ffmpeg_exe_name)
    if ffmpeg_in_path:
        return ffmpeg_in_path

    raise FileNotFoundError(
        f"ffmpeg ('{ffmpeg_exe_name}') not found. Please ensure ffmpeg is installed and in your system PATH."
    )

def extract_audio_from_video(video_input_path, target_audio_path, ffmpeg_executable_path):
    """Extracts audio from video using ffmpeg."""
    command = [
        ffmpeg_executable_path,
        '-threads', '8',
        '-i', video_input_path,
        '-vn',  # Disable video recording
        '-acodec', 'pcm_s16le',  # Audio codec: PCM signed 16-bit little-endian
        '-ar', '16000',  # Audio sample rate: 16kHz
        '-ac', '1',  # Audio channels: 1 (mono)
        '-y',  # Overwrite output file if it exists
        target_audio_path
    ]
    try:
        process = subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        error_message = f"ffmpeg audio extraction failed. Return code: {e.returncode}. Error: {e.stderr}"
        raise RuntimeError(error_message) from e
    except FileNotFoundError:
        raise FileNotFoundError(f"ffmpeg executable not found at {ffmpeg_executable_path} when trying to run subprocess.")

def _process_funasr_segments(funasr_output_list, diarization_enabled, enable_segment_merging, max_merge_gap_ms, max_merged_segment_duration_ms):
    """
    Processes raw FunASR output, performs optional merging, and transforms it
    into a target schema with auxiliary speaker data.
    Returns a dictionary containing 'transcription_result' and 'speaker_mapping'.
    """
    empty_result_package = {
        "transcription_result": {"segments": [], "language": "zh"},
        "speaker_mapping": []
    }

    if not funasr_output_list:
        return empty_result_package

    # 1. Raw Segment Extraction
    # Extracts text, start (ms), end (ms), and spk for each sentence.
    raw_segments_ms_spk = []
    for result_item in funasr_output_list:
        if not isinstance(result_item, dict):
            continue
        sentence_info = result_item.get("sentence_info")
        if sentence_info and isinstance(sentence_info, list):
            for sentence_data in sentence_info:
                if isinstance(sentence_data, dict) and \
                   "start" in sentence_data and \
                   "end" in sentence_data and \
                   "text" in sentence_data:
                    raw_segments_ms_spk.append({
                        "text": str(sentence_data["text"]).strip(),
                        "start": int(sentence_data["start"]), # in ms
                        "end": int(sentence_data["end"]),     # in ms
                        "spk": sentence_data.get("spk")
                    })

    if not raw_segments_ms_spk:
        return empty_result_package

    # This list will hold segments with start/end in ms and effective spk ID
    processed_segments_ms_spk = []

    # 2. Conditional Segment Merging
    if not enable_segment_merging:
        processed_segments_ms_spk = raw_segments_ms_spk
    else:
        if not raw_segments_ms_spk: # Should be caught by earlier check, but defensive
             return empty_result_package
        
        current_merged_segment = raw_segments_ms_spk[0].copy()

        for i in range(1, len(raw_segments_ms_spk)):
            next_segment = raw_segments_ms_spk[i]
            
            gap = next_segment['start'] - current_merged_segment['end']
            potential_duration = next_segment['end'] - current_merged_segment['start']

            # Speaker compatibility for merging:
            # - Diarization not enabled OR
            # - Current segment's speaker is None (treat as wildcard) OR
            # - Next segment's speaker is None (treat as wildcard) OR
            # - Speakers are identical.
            # The effective speaker of the merged segment will be that of the *first* segment in the merge group.
            can_merge_speakers = (
                not diarization_enabled or
                current_merged_segment['spk'] is None or
                next_segment['spk'] is None or
                current_merged_segment['spk'] == next_segment['spk']
            )

            if (can_merge_speakers and
                gap >= 0 and # Segments must be in order or touch
                gap <= max_merge_gap_ms and
                potential_duration <= max_merged_segment_duration_ms):
                # Merge: append text, update end time. Speaker ID remains from the first segment.
                current_merged_segment['text'] += " " + next_segment['text']
                current_merged_segment['end'] = next_segment['end']
            else:
                # Finalize current_merged_segment, start new one
                processed_segments_ms_spk.append(current_merged_segment)
                current_merged_segment = next_segment.copy()
        
        processed_segments_ms_spk.append(current_merged_segment) # Add the last segment

    # 3. Output Transformation
    output_segments_for_schema = []
    segment_speaker_mapping = []

    for seg_ms_spk in processed_segments_ms_spk:
        output_segments_for_schema.append({
            "text": seg_ms_spk["text"],
            "start": round(seg_ms_spk["start"] / 1000.0, 3), # Convert ms to seconds, round to 3 decimal places
            "end": round(seg_ms_spk["end"] / 1000.0, 3)    # Convert ms to seconds, round to 3 decimal places
        })
        segment_speaker_mapping.append(seg_ms_spk["spk"]) # Can be None

    return {
        "transcription_result": {
            "segments": output_segments_for_schema,
            "language": "zh"
        },
        "speaker_mapping": segment_speaker_mapping
    }

def main():
    parser = argparse.ArgumentParser(description="Transcribe video to SRT using WhisperX.")
    # Track whether alignment failed anywhere so we can reflect this in the final event
    alignment_failed = False
    parser.add_argument("video_file_path", help="Absolute path to the video file.")
    parser.add_argument("--output_srt_path", help="Optional: File path to write SRT output. Prints to stdout if not given.", default=None)
    
    parser.add_argument("--language", type=str, default=None, help="Source language code (e.g., 'en', 'es'). If None, language is auto-detected by WhisperX.")
    parser.add_argument("--compute_type", type=str, default="float16", help="Compute type for the model (e.g., 'float32', 'int8', 'float16', 'int8_float16'). Default: float16")
    
    # New arguments for WhisperX
    parser.add_argument("--batch_size", default=4, type=int, help="the preferred batch size for inference")
    parser.add_argument("--enable_diarization", type=str_to_bool, nargs='?', const=True, default=False, help="Enable speaker diarization (1-2 speakers). Requires --hf_token.")
    parser.add_argument("--hf_token", type=str, default=None, help="Hugging Face token, required if --enable_diarization is True.")
    parser.add_argument("--condition_on_previous_text", action="store_true", help="Enable conditioning on previous text during transcription.")
    parser.add_argument("--threads", type=int, default=8, help="Number of CPU threads to use for computation. Default: 8")
    parser.add_argument("--max_line_width", type=int, default=None, help="(not possible with --no_align) the maximum number of characters in a line before breaking the line")
    parser.add_argument("--max_line_count", type=int, default=1, help="Optional: Maximum number of lines per SRT segment for WhisperX output (e.g., 1).")
    parser.add_argument("--highlight_words", action="store_true", help="Optional: Enable word highlighting in SRT output from WhisperX.")
    parser.add_argument("--model_cache_path", type=str, default=None, help="Optional: Path to cache WhisperX models.")

    # Arguments for FunASR segment merging
    parser.add_argument("--enable_segment_merging", action="store_true", default=True, help="Enable sentence segment merging for FunASR output.")
    parser.add_argument("--max_merge_gap_ms", type=int, default=2000, help="Maximum silence duration (ms) between segments to allow merging (FunASR only). Default: 500")
    parser.add_argument("--max_merged_segment_duration_ms", type=int, default=10000, help="Maximum total duration (ms) of a merged segment (FunASR only). Default: 10000")

    args = parser.parse_args()

    if args.threads > 0:
        torch.set_num_threads(args.threads)

    temp_audio_file_path = None # Initialize to ensure it's defined for finally block
    try:
        # 0. Resolve ffmpeg path
        ffmpeg_path = get_ffmpeg_path()
        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'status': f'Using ffmpeg at: {ffmpeg_path}'})}", file=sys.stdout, flush=True)

        # 0.5 Create temporary file for audio
        # Using delete=False because we need to pass the path to ffmpeg, then to whisperx
        # We will manually delete it in the finally block.
        # dir=None uses the system's default temporary directory.
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False, dir=None) as tmp_audio_file:
            temp_audio_file_path = tmp_audio_file.name
        
        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'status': f'Temporary audio file will be: {temp_audio_file_path}'})}", file=sys.stdout, flush=True)

        # 0.8 Extract Audio using ffmpeg
        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 5, 'status': 'Extracting audio using ffmpeg...'})}", file=sys.stdout, flush=True)
        extract_audio_from_video(args.video_file_path, temp_audio_file_path, ffmpeg_path)
        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 15, 'status': 'Audio extraction complete.'})}", file=sys.stdout, flush=True)

        # 1. Determine device & Load audio (once for both paths)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 18, 'status': f'Using device: {device}. Loading audio for ASR processing...'})}", file=sys.stdout, flush=True)
        audio = whisperx.load_audio(temp_audio_file_path)
        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 19, 'status': 'Audio loaded.'})}", file=sys.stdout, flush=True)

        full_srt_output = ""
        detected_language = args.language # Default to specified, will be updated by ASR

        # Common SRT writer options
        writer_options_dict = {
            "max_line_width": None, # WhisperX handles None if not set by arg
            "max_line_count": 1,
            "highlight_words": args.highlight_words
        }

        # 2. Determine engine and process
        if args.language and args.language.lower().startswith('zh'):
            # --- FunASR Path ---
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 20, 'status': 'Initializing FunASR for Chinese...'})}", file=sys.stdout, flush=True)
            try:
                funasr_pipeline = AutoModel(
                    model="paraformer-zh",
                    vad_model="fsmn-vad",
                    punc_model="ct-punc",
                    spk_model="cam++",
                    ncpu=args.threads,
                    device=device,
                    vad_kwargs={"max_single_segment_time": 10000},
                )
                print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 30, 'status': f'FunASR model loaded on {device}.'})}", file=sys.stdout, flush=True)

                print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 35, 'status': 'FunASR transcribing...'})}", file=sys.stdout, flush=True)
                try:
                    funasr_results = funasr_pipeline.generate(
                        input=temp_audio_file_path,
                        pred_timestamp=True,
                        sentence_timestamp=True,
                        merge_vad=True,
                        merge_length_s=10,
                        return_spk_res=True # Get FunASR spk if available (though will be overridden by WhisperX diarization if enabled)
                    )
                except Exception as funasr_transcribe_error:
                    if "out of memory" in str(funasr_transcribe_error).lower() and device == "cuda":
                        print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': 'FunASR: GPU out of memory during transcription. Retrying on CPU...'})}", file=sys.stdout, flush=True)
                        
                        # Clean up GPU resources
                        cleanup_model(funasr_pipeline, device)

                        # Reload model on CPU and retry
                        cpu_device = "cpu"
                        if args.threads > 0:
                            torch.set_num_threads(args.threads)
                        
                        funasr_pipeline = AutoModel(
                            model="paraformer-zh",
                            vad_model="fsmn-vad",
                            punc_model="ct-punc",
                            spk_model="cam++",
                            ncpu=args.threads,
                            device=cpu_device,
                            vad_kwargs={"max_single_segment_time": 10000},
                        )
                        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 45, 'status': 'FunASR model re-loaded on CPU. Retrying transcription...'})}", file=sys.stdout, flush=True)
                        funasr_results = funasr_pipeline.generate(
                            input=temp_audio_file_path,
                            pred_timestamp=True,
                            sentence_timestamp=True,
                            merge_vad=True,
                            merge_length_s=10,
                            return_spk_res=True
                        )
                    else:
                        # Re-raise other transcription errors
                        raise funasr_transcribe_error
                detected_language = 'zh'
                print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 65, 'status': 'FunASR transcription complete.', 'detected_language': 'zh'})}", file=sys.stdout, flush=True)
                
                # Cleanup FunASR model to free VRAM
                cleanup_model(funasr_pipeline, device)

                funasr_processed_output_dict = _process_funasr_segments(
                    funasr_results,
                    args.enable_diarization,
                    args.enable_segment_merging,
                    args.max_merge_gap_ms,
                    args.max_merged_segment_duration_ms
                )
                
                segments_for_alignment = funasr_processed_output_dict["transcription_result"]["segments"]
                language_code_for_alignment = funasr_processed_output_dict["transcription_result"]["language"] # Should be "zh"

                if not segments_for_alignment:
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'status': 'FunASR: No segments from _process_funasr_segments to align.'})}", file=sys.stdout, flush=True)
                    full_srt_output = ""
                else:
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 70, 'status': 'FunASR: Aligning segments with WhisperX...'})}", file=sys.stdout, flush=True)
                    
                    aligned_funasr_result = None # Initialize before try block
                    model_a, metadata_a = None, None # Ensure they are defined for the finally block
                    try:
                        model_a, metadata_a = whisperx.load_align_model(language_code=language_code_for_alignment, device=device)
                        aligned_funasr_result = whisperx.align(segments_for_alignment, model_a, metadata_a, audio, device, return_char_alignments=False)
                        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 75, 'status': 'FunASR: WhisperX alignment complete.'})}", file=sys.stdout, flush=True)
                    except Exception as align_error:
                        # Try CPU fallback if OOM on CUDA
                        if "out of memory" in str(align_error).lower() and device == "cuda":
                            print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': 'FunASR: GPU out of memory during alignment. Retrying on CPU...'})}", file=sys.stdout, flush=True)
                            # Cleanup GPU alignment model
                            cleanup_model(model_a, device)
                            if 'metadata_a' in locals() and metadata_a:
                                del metadata_a
                            gc.collect()
                            torch.cuda.empty_cache()
                            # Reload on CPU and retry
                            cpu_device = "cpu"
                            model_a, metadata_a = whisperx.load_align_model(language_code=language_code_for_alignment, device=cpu_device)
                            aligned_funasr_result = whisperx.align(segments_for_alignment, model_a, metadata_a, audio, cpu_device, return_char_alignments=False)
                            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 75, 'status': 'FunASR: WhisperX alignment complete on CPU (fallback).'})}", file=sys.stdout, flush=True)
                        else:
                            # If alignment fails for any other reason, log a warning and proceed with unaligned segments.
                            alignment_failed = True
                            print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': 'Warning: alignment fails'})}", file=sys.stdout, flush=True)
                            print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': f'FunASR: Alignment failed: {str(align_error)}. Proceeding with unaligned segments.'})}", file=sys.stdout, flush=True)
                            # aligned_funasr_result remains None
                    finally:
                        # Cleanup alignment model
                        cleanup_model(model_a, device if model_a is not None else "cpu")
                        if 'metadata_a' in locals() and metadata_a:
                            del metadata_a
                        gc.collect()
                        if device == "cuda":
                            torch.cuda.empty_cache()

                    # If alignment was successful, proceed with diarization if enabled.
                    # Otherwise, use the unaligned segments.
                    if aligned_funasr_result:
                        result_to_use_for_srt = aligned_funasr_result

                        if args.enable_diarization and args.hf_token:
                            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 80, 'status': 'FunASR: Performing WhisperX diarization...'})}", file=sys.stdout, flush=True)
                            diarize_model = None
                            try:
                                diarize_model = whisperx.diarize.DiarizationPipeline(use_auth_token=args.hf_token, device=device)
                                diarize_segments_funasr = diarize_model(audio, min_speakers=1, max_speakers=2)
                                result_to_use_for_srt = whisperx.assign_word_speakers(diarize_segments_funasr, aligned_funasr_result)
                                print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 85, 'status': 'FunASR: WhisperX diarization complete.'})}", file=sys.stdout, flush=True)
                            except Exception as diarization_error_funasr:
                                print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'progress': 83, 'status': f'FunASR: WhisperX diarization failed: {str(diarization_error_funasr)}. Proceeding without speaker labels.'})}", file=sys.stdout, flush=True)
                            finally:
                                # Cleanup diarization model
                                cleanup_model(diarize_model, device)
                        elif args.enable_diarization and not args.hf_token:
                            print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'progress': 80, 'status': 'FunASR: Diarization enabled but Hugging Face token not provided. Skipping WhisperX diarization.'})}", file=sys.stdout, flush=True)
                    else:
                        # Alignment failed, use the original unaligned segments
                        result_to_use_for_srt = {"segments": segments_for_alignment}
                    
                    # Ensure language key is present for SRT writer
                    if "language" not in result_to_use_for_srt or not result_to_use_for_srt.get("language"):
                        result_to_use_for_srt["language"] = language_code_for_alignment
                    
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 90, 'status': 'FunASR: Generating SRT via WhisperX writer...'})}", file=sys.stdout, flush=True)
                    srt_writer = whisperx.utils.WriteSRT(output_dir=None) # output_dir=None writes to memory buffer
                    string_io_buffer = io.StringIO()
                    srt_writer.write_result(result_to_use_for_srt, file=string_io_buffer, options=writer_options_dict)
                    full_srt_output = string_io_buffer.getvalue()
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 95, 'status': 'FunASR: SRT content generated via WhisperX.'})}", file=sys.stdout, flush=True)

            except Exception as funasr_error:
                print(f"PROGRESS_JSON:{json.dumps({'type': 'error', 'status': f'FunASR processing failed: {str(funasr_error)}'})}", file=sys.stdout, flush=True)
                raise RuntimeError(f"FunASR processing failed: {str(funasr_error)}") from funasr_error
        
        else:
            # --- WhisperX Path (for non-Chinese languages) ---
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 20, 'status': 'Initializing WhisperX...'})}", file=sys.stdout, flush=True)
            
            model_download_root = None
            if args.model_cache_path:
                try:
                    os.makedirs(args.model_cache_path, exist_ok=True)
                    model_download_root = args.model_cache_path
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'status': f'Using WhisperX model cache at: {model_download_root}'})}", file=sys.stdout, flush=True)
                except Exception as e_cache:
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': f'Failed to create/access model cache path {args.model_cache_path}: {str(e_cache)}. Using default.'})}", file=sys.stdout, flush=True)

            # Determine model based on language
            model_name = "large-v3-turbo" # Default model
            if args.language:
                if args.language.lower() == 'ja':
                    model_name = "kotoba-tech/kotoba-whisper-v2.0-faster"
                elif args.language.lower() == 'ko':
                    model_name = "arc-r/faster-whisper-large-v2-Ko"

            model = whisperx.load_model(
                model_name,
                device,
                compute_type=args.compute_type,
                language=args.language, # WhisperX handles None for auto-detection
                download_root=model_download_root,
                threads=args.threads,
            )
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 30, 'status': f'WhisperX model loaded on {device}.'})}", file=sys.stdout, flush=True)
            
            # Audio is already loaded before this if/else block
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 35, 'status': 'WhisperX transcribing (using pre-loaded audio)...'})}", file=sys.stdout, flush=True)
            try:
                result = model.transcribe(audio, batch_size=args.batch_size, chunk_size=10, language=args.language)
            except Exception as transcribe_error:
                if "out of memory" in str(transcribe_error).lower() and device == "cuda":
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': 'WhisperX: GPU out of memory during transcription. Retrying on CPU...'})}", file=sys.stdout, flush=True)
                    # Cleanup GPU model
                    cleanup_model(model, device)
                    # Reload on CPU and retry
                    cpu_device = "cpu"
                    model = whisperx.load_model(
                        model_name,
                        cpu_device,
                        compute_type="float32",  # safer on CPU
                        language=args.language,
                        download_root=model_download_root,
                        threads=args.threads,
                    )
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'status': 'WhisperX model re-loaded on CPU. Retrying transcription...'})}", file=sys.stdout, flush=True)
                    result = model.transcribe(audio, batch_size=max(1, args.batch_size // 2), chunk_size=10, language=args.language)
                else:
                    raise

            detected_language = result["language"] # Update detected_language
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 60, 'status': 'WhisperX transcription complete.', 'detected_language': detected_language, 'duration_seconds': audio.shape[0] / whisperx.audio.SAMPLE_RATE})}", file=sys.stdout, flush=True)

            # Cleanup transcription model
            cleanup_model(model, device)

            # 4. Align
            aligned_result = None # Initialize before try block
            model_a, metadata = None, None # Ensure they are defined for the finally block
            try:
                model_a, metadata = whisperx.load_align_model(language_code=detected_language, device=device)
                aligned_result = whisperx.align(result["segments"], model_a, metadata, audio, device, return_char_alignments=False)
                print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 75, 'status': 'WhisperX alignment complete.'})}", file=sys.stdout, flush=True)
            except Exception as align_error:
                # Try CPU fallback for alignment if OOM on CUDA
                if "out of memory" in str(align_error).lower() and device == "cuda":
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': 'WhisperX: GPU out of memory during alignment. Retrying on CPU...'})}", file=sys.stdout, flush=True)
                    # Clean up GPU alignment model
                    cleanup_model(model_a, device)
                    if 'metadata' in locals() and metadata:
                        del metadata
                    gc.collect()
                    torch.cuda.empty_cache()
                    # Reload alignment model on CPU and retry
                    cpu_device = "cpu"
                    model_a, metadata = whisperx.load_align_model(language_code=detected_language, device=cpu_device)
                    aligned_result = whisperx.align(result["segments"], model_a, metadata, audio, cpu_device, return_char_alignments=False)
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 75, 'status': 'WhisperX alignment complete on CPU (fallback).'})}", file=sys.stdout, flush=True)
                else:
                    alignment_failed = True
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': 'Warning: alignment fails'})}", file=sys.stdout, flush=True)
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': f'WhisperX: Alignment failed: {str(align_error)}. Proceeding with unaligned segments.'})}", file=sys.stdout, flush=True)
                    # aligned_result remains None
            finally:
                # Cleanup alignment model
                cleanup_model(model_a, device if model_a is not None else "cpu")
                if 'metadata' in locals() and metadata:
                    del metadata
                gc.collect()
                if device == "cuda":
                    torch.cuda.empty_cache()

            # 5. Diarization (only if alignment succeeded)
            result_diarized = None
            if aligned_result:
                if args.enable_diarization and args.hf_token:
                    diarize_model = None
                    try:
                        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 80, 'status': 'WhisperX starting diarization...'})}", file=sys.stdout, flush=True)
                        diarize_model = whisperx.diarize.DiarizationPipeline(use_auth_token=args.hf_token, device=device)
                        diarize_segments = diarize_model(audio) # Default behavior
                        if args.enable_diarization: # This check is a bit redundant but keeps logic clear
                            diarize_segments = diarize_model(audio, min_speakers=1, max_speakers=2)
                        
                        result_diarized = whisperx.assign_word_speakers(diarize_segments, aligned_result)
                        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 90, 'status': 'WhisperX diarization complete.'})}", file=sys.stdout, flush=True)
                    except Exception as diarization_error:
                        print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'progress': 85, 'status': f'WhisperX diarization failed: {str(diarization_error)}. Proceeding without speaker labels.'})}", file=sys.stdout, flush=True)
                        # result_diarized remains None
                    finally:
                        # Cleanup diarization model
                        cleanup_model(diarize_model, device)
                elif args.enable_diarization and not args.hf_token:
                     print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'progress': 80, 'status': 'WhisperX Diarization enabled but Hugging Face token not provided. Skipping diarization.'})}", file=sys.stdout, flush=True)
            
            # 6. SRT writing
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 90, 'status': 'Generating SRT content using WhisperX writer...'})}", file=sys.stdout, flush=True)
            
            writer_options_dict = {
                "max_line_width": None,
                "max_line_count": 1,
                "highlight_words": args.highlight_words,
            }

            # Determine the correct result dictionary to use for the writer.
            if result_diarized:
                result_to_use_for_srt = result_diarized
            elif aligned_result:
                result_to_use_for_srt = aligned_result
            else:
                # Fallback to the original unaligned transcription result
                result_to_use_for_srt = result
            
            # Ensure the result_to_use_for_srt has the 'language' key.
            if "language" not in result_to_use_for_srt or not result_to_use_for_srt.get("language"):
                 result_to_use_for_srt["language"] = detected_language

            srt_writer = whisperx.utils.WriteSRT(output_dir=None)
            string_io_buffer = io.StringIO()
            
            srt_writer.write_result(result_to_use_for_srt, file=string_io_buffer, options=writer_options_dict)
            full_srt_output = string_io_buffer.getvalue()
            
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 95, 'status': 'WhisperX SRT content generated via new method.'})}", file=sys.stdout, flush=True)
        # End of WhisperX specific path, full_srt_output is populated by either FunASR or WhisperX path.
        
        # 7. Output (Common for both FunASR and WhisperX)
        if args.output_srt_path:
            with open(args.output_srt_path, "w", encoding="utf-8") as f:
                f.write(full_srt_output)
            print(f"PROGRESS_JSON:{json.dumps({'type': 'complete', 'progress': 100, 'status': 'SRT file generated.', 'output_path': args.output_srt_path, 'detected_language': detected_language, 'alignment': ('failed' if alignment_failed else 'ok')})}", file=sys.stdout, flush=True)
        else:
            # Print to stdout, ensuring no PROGRESS_JSON prefix for the actual SRT data
            sys.stdout.write(full_srt_output)
            sys.stdout.flush() # Ensure it's written out
            # Send a completion message if printing to stdout as well
            print(f"PROGRESS_JSON:{json.dumps({'type': 'complete', 'progress': 100, 'status': 'SRT content printed to stdout.', 'detected_language': detected_language})}", file=sys.stderr, flush=True) # Use stderr for final status if stdout is data

    except Exception as e:
        error_code = "PROCESSING_FAILED"
        user_message = f"An error occurred: {str(e)}"
        
        if "ffmpeg executable not found" in str(e):
            error_code = "FFMPEG_NOT_FOUND"
            user_message = f"Error: ffmpeg executable not found. Please ensure it is correctly placed in the 'ffmpeg' directory. Details: {str(e)}"
        elif "ffmpeg audio extraction failed" in str(e):
            error_code = "AUDIO_EXTRACTION_FAILED"
            user_message = f"Error: Audio extraction using ffmpeg failed. Details: {str(e)}"
        elif isinstance(e, FileNotFoundError) and args.video_file_path in str(e): # Check if it's the input video file
             error_code = "INPUT_VIDEO_NOT_FOUND"
             user_message = f"Error: Input video file not found at {args.video_file_path}. Details: {str(e)}"
        elif "out of memory" in str(e).lower():
            error_code = "OUT_OF_MEMORY"
            user_message = f"Error: Ran out of memory during ASR processing. Try a different compute type or ensure sufficient resources. Details: {str(e)}"
        else: # Generic ASR or other processing error
            error_code = "ASR_PROCESSING_FAILED"
            user_message = f"An error occurred during ASR processing: {str(e)}"

        error_payload = {
            "error_code": error_code,
            "message": user_message,
            "details": str(e)
        }
        # Send structured error to stderr
        print(json.dumps(error_payload), file=sys.stderr, flush=True)
        # Send PROGRESS_JSON error to stdout for compatibility with existing JS parsing
        print(f"PROGRESS_JSON:{json.dumps({'type': 'error', 'message': user_message, 'error_code': error_code, 'details': str(e)})}", file=sys.stdout, flush=True)
        sys.exit(1)
    finally:
        if temp_audio_file_path and os.path.exists(temp_audio_file_path):
            try:
                os.remove(temp_audio_file_path)
            except Exception as e_clean:
                print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'status': f'Failed to delete temporary audio file {temp_audio_file_path}: {str(e_clean)}'})}", file=sys.stdout, flush=True)

if __name__ == "__main__":
    main()