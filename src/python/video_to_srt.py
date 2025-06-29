import argparse
import json
import sys
import os
import platform
import subprocess
import tempfile
import shutil # Added for shutil.which
import torch # Added for device check
import whisperx
import io # Added for StringIO
from funasr import AutoModel

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

def get_ffmpeg_path():
    """Determines the path to the ffmpeg executable."""
    ffmpeg_exe_name = "ffmpeg.exe" if platform.system() == "Windows" else "ffmpeg"

    # Path 1: Relative to the script, assuming Electron Forge structure
    # Script is typically in '.../resources/app(.asar.unpacked)/src/python/' or '.../resources/python/'
    # FFmpeg is typically in '.../resources/ffmpeg/'
    try:
        # __file__ is the path to the current script (video_to_srt.py)
        script_path = os.path.abspath(__file__)
        script_dir = os.path.dirname(script_path) # e.g., .../resources/python

        # Go up one level from script_dir to get to the parent 'resources' (or equivalent) directory
        parent_of_script_dir = os.path.dirname(script_dir)

        # Path A: '.../resources/ffmpeg/ffmpeg.exe'
        ffmpeg_path_electron = os.path.join(parent_of_script_dir, 'ffmpeg', ffmpeg_exe_name)
        if os.path.exists(ffmpeg_path_electron):
            return ffmpeg_path_electron
        
        # Path B: If script is in '.../resources/app/python' and ffmpeg in '.../resources/ffmpeg'
        # then parent_of_script_dir is '.../resources/app', its parent is '.../resources'
        resources_dir_candidate = os.path.dirname(parent_of_script_dir)
        ffmpeg_path_electron_alt = os.path.join(resources_dir_candidate, 'ffmpeg', ffmpeg_exe_name)
        if os.path.exists(ffmpeg_path_electron_alt):
            return ffmpeg_path_electron_alt

    except Exception: # pylint: disable=broad-except
        # This might happen if __file__ is not defined as expected (e.g. in some frozen contexts not via PyInstaller)
        pass # Continue to other checks

    # Path 2: Development mode (script run directly from project_root/src/python)
    # ffmpeg is in project_root/ffmpeg/
    try:
        script_dir_dev = os.path.dirname(os.path.abspath(__file__)) # project_root/src/python
        # project_root is two levels up from src/python
        project_root_dev = os.path.abspath(os.path.join(script_dir_dev, '..', '..'))
        
        dev_path_ffmpeg_subdir = os.path.join(project_root_dev, 'ffmpeg', ffmpeg_exe_name)
        if os.path.exists(dev_path_ffmpeg_subdir):
            return dev_path_ffmpeg_subdir
    except Exception: # pylint: disable=broad-except
        pass

    # Path 3: Check system PATH (last resort)
    ffmpeg_in_path = shutil.which(ffmpeg_exe_name)
    if ffmpeg_in_path:
        return ffmpeg_in_path

    raise FileNotFoundError(
        f"ffmpeg ('{ffmpeg_exe_name}') not found. Please ensure ffmpeg is in your system PATH, "
        f"or bundled correctly with the Electron Forge application (e.g., in 'resources/ffmpeg/'), "
        f"or in the project root 'ffmpeg/' directory for development."
    )

def extract_audio_from_video(video_input_path, target_audio_path, ffmpeg_executable_path):
    """Extracts audio from video using ffmpeg."""
    command = [
        ffmpeg_executable_path,
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
            "language": "zh" # Assuming Chinese for FunASR as per plan
        },
        "speaker_mapping": segment_speaker_mapping
    }

def main():
    parser = argparse.ArgumentParser(description="Transcribe video to SRT using WhisperX.")
    parser.add_argument("video_file_path", help="Absolute path to the video file.")
    # Removed --model_path
    parser.add_argument("--output_srt_path", help="Optional: File path to write SRT output. Prints to stdout if not given.", default=None)
    
    parser.add_argument("--language", type=str, default=None, help="Source language code (e.g., 'en', 'es'). If None, language is auto-detected by WhisperX.")
    parser.add_argument("--compute_type", type=str, default="float16", help="Compute type for the model (e.g., 'float32', 'int8', 'float16', 'int8_float16'). Default: float16")
    
    # New arguments for WhisperX
    parser.add_argument("--batch_size", default=16, type=int, help="the preferred batch size for inference")
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
    
    # Removed VAD, (old)cpu_threads, num_workers arguments as WhisperX handles them differently or internally

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
                funasr_results = funasr_pipeline.generate(
                    input=temp_audio_file_path,
                    pred_timestamp=True,
                    sentence_timestamp=True,
                    merge_vad=True,
                    merge_length_s=10,
                    return_spk_res=True # Get FunASR spk if available (though will be overridden by WhisperX diarization if enabled)
                )
                detected_language = 'zh'
                print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 65, 'status': 'FunASR transcription complete.', 'detected_language': 'zh'})}", file=sys.stdout, flush=True)
                
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
                    model_a, metadata_a = whisperx.load_align_model(language_code=language_code_for_alignment, device=device)
                    aligned_funasr_result = whisperx.align(segments_for_alignment, model_a, metadata_a, audio, device, return_char_alignments=False)
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 75, 'status': 'FunASR: WhisperX alignment complete.'})}", file=sys.stdout, flush=True)

                    result_to_use_for_srt = aligned_funasr_result # Default to aligned result

                    if args.enable_diarization and args.hf_token:
                        print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 80, 'status': 'FunASR: Performing WhisperX diarization...'})}", file=sys.stdout, flush=True)
                        try:
                            diarize_model = whisperx.diarize.DiarizationPipeline(use_auth_token=args.hf_token, device=device)
                            # Using min_speakers=1, max_speakers=2 as a default, can be made configurable if needed
                            diarize_segments_funasr = diarize_model(audio, min_speakers=1, max_speakers=2)
                            result_to_use_for_srt = whisperx.assign_word_speakers(diarize_segments_funasr, aligned_funasr_result)
                            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 85, 'status': 'FunASR: WhisperX diarization complete.'})}", file=sys.stdout, flush=True)
                        except Exception as diarization_error_funasr:
                            print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'progress': 83, 'status': f'FunASR: WhisperX diarization failed: {str(diarization_error_funasr)}. Proceeding without speaker labels.'})}", file=sys.stdout, flush=True)
                    elif args.enable_diarization and not args.hf_token:
                        print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'progress': 80, 'status': 'FunASR: Diarization enabled for FunASR path but Hugging Face token not provided. Skipping WhisperX diarization.'})}", file=sys.stdout, flush=True)
                    
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

            model = whisperx.load_model(
                "large-v3-turbo", # Consider making model name an arg
                device,
                compute_type=args.compute_type,
                language=args.language, # WhisperX handles None for auto-detection
                download_root=model_download_root,
                threads=args.threads,
            )
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 30, 'status': f'WhisperX model loaded on {device}.'})}", file=sys.stdout, flush=True)
            
            # Audio is already loaded before this if/else block
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 35, 'status': 'WhisperX transcribing (using pre-loaded audio)...'})}", file=sys.stdout, flush=True)
            result = model.transcribe(audio, batch_size=args.batch_size, chunk_size=10, language=args.language)
            
            detected_language = result["language"] # Update detected_language
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 60, 'status': 'WhisperX transcription complete.', 'detected_language': detected_language, 'duration_seconds': audio.shape[0] / whisperx.audio.SAMPLE_RATE})}", file=sys.stdout, flush=True)

            # 4. Align
            model_a, metadata = whisperx.load_align_model(language_code=detected_language, device=device)
            aligned_result = whisperx.align(result["segments"], model_a, metadata, audio, device, return_char_alignments=False)
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 75, 'status': 'WhisperX alignment complete.'})}", file=sys.stdout, flush=True)

            # 5. Speak Diarization
            # For WhisperX, hf_token is required for diarization
            if not args.hf_token:
                print(f"PROGRESS_JSON:{json.dumps({'type': 'warning', 'progress': 80, 'status': 'WhisperX Diarization enabled but Hugging Face token not provided. Skipping diarization.'})}", file=sys.stdout, flush=True)
            else:
                try:
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 80, 'status': 'WhisperX starting diarization...'})}", file=sys.stdout, flush=True)
                    diarize_model = whisperx.diarize.DiarizationPipeline(use_auth_token=args.hf_token, device=device)
                    if args.enable_diarization:
                        diarize_segments = diarize_model(audio, min_speakers=1, max_speakers=2)
                    else:
                        diarize_segments = diarize_model(audio)
                    result_diarized = whisperx.assign_word_speakers(diarize_segments, aligned_result)
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 90, 'status': 'WhisperX diarization complete.'})}", file=sys.stdout, flush=True)
                except Exception as diarization_error:
                    print(f"PROGRESS_JSON:{json.dumps({'type': 'error', 'progress': 85, 'status': f'WhisperX diarization failed: {str(diarization_error)}. Proceeding without speaker labels.'})}", file=sys.stdout, flush=True)
            
            # Generate SRT from WhisperX segments using whisperx.utils.WriteSRT
            print(f"PROGRESS_JSON:{json.dumps({'type': 'info', 'progress': 90, 'status': 'Generating SRT content using WhisperX writer...'})}", file=sys.stdout, flush=True)
            
            # 6. SRT writing
            writer_options_dict = {
                "max_line_width": None,  # Using WhisperX's default
                "max_line_count": 1,
                "highlight_words": args.highlight_words,
            }

            # Determine the correct result dictionary to use for the writer.
            # 'aligned_result' is the base dictionary from the alignment step.
            # If diarization was enabled, attempted, and 'result_diarized' was created, use that.
            if args.enable_diarization and args.hf_token and 'result_diarized' in locals():
                # This assumes 'result_diarized' is populated if diarization was successful.
                result_to_use_for_srt = result_diarized
            else:
                # Fallback to aligned_result if diarization was not enabled, or if it was attempted but 'result_diarized' wasn't set.
                result_to_use_for_srt = aligned_result
            
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
            print(f"PROGRESS_JSON:{json.dumps({'type': 'complete', 'progress': 100, 'status': 'SRT file generated.', 'output_path': args.output_srt_path, 'detected_language': detected_language})}", file=sys.stdout, flush=True)
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