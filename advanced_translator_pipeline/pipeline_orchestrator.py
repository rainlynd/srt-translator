"""
Main orchestrator for the advanced translation pipeline.

This module will be the primary entry point called by the Electron application.
It will coordinate the different stages of the translation process:
1. ASR (Automatic Speech Recognition)
2. Text Segmentation (NLP-based and Meaning-based)
3. Terminology Extraction / Summarization
4. Translation (3-step Gemini process)
5. SRT Generation
"""

# Standard library imports
import os # For dummy file creation in main, and path joining

# Import a Pydantic model for type hinting if we define one for config.
# from typing import Dict # Or your Pydantic model

# Local project imports (sibling modules)
from .asr_module import ASRProcessor
from .segmentation_module import TextSegmenter
from .terminology_module import TerminologyExtractor
from .translation_module import Translator
from .srt_utils_module import SRTGenerator
from .common_utils import GeminiClient


def run(input_path: str, target_lang: str, source_lang: str, config: dict, cache_path: str, pipeline_mode: str) -> str:
    """
    Main function to run the translation pipeline.

    Args:
        input_path (str): Path to the input video/audio file or SRT file.
        target_lang (str): Target language code (e.g., 'es').
        source_lang (str): Source language code (e.g., 'en').
        config (dict): Configuration dictionary containing settings for various pipeline stages.
        cache_path (str): Path to the directory where intermediate files will be cached.
        pipeline_mode (str): Mode of operation, e.g., "full" (video/audio to translated SRT)
                             or "srt_translate" (SRT to translated SRT).

    Returns:
        str: Path to the final translated SRT file.
    """
    print(f"Pipeline started with mode: {pipeline_mode}")
    print(f"Input path: {input_path}")
    print(f"Target language: {target_lang}")
    print(f"Source language: {source_lang}")
    print(f"Configuration: {config}")
    print(f"Cache path: {cache_path}")

    # 1. Initialize modules
    # Retrieve API key for Gemini from the main config (passed by Electron)
    gemini_api_key = config.get("gemini_api_key") # Ensure this key exists in the config structure
    if not gemini_api_key:
        # In a real app, this should probably raise an error or be handled more gracefully
        print("Error: Gemini API key not found in configuration.")
        return f"{cache_path}/error_no_api_key.txt" # Or raise an exception

    gemini_client = GeminiClient(api_key=gemini_api_key, client_config=config.get("gemini_settings"))

    asr_processor = ASRProcessor(config=config.get("asr_settings", {}), cache_path=os.path.join(cache_path, "asr"))
    segmenter = TextSegmenter(config=config.get("segmentation_settings", {}), cache_path=os.path.join(cache_path, "segmentation"), gemini_client=gemini_client)
    terminologist = TerminologyExtractor(config=config.get("terminology_settings", {}), cache_path=os.path.join(cache_path, "terminology"), gemini_client=gemini_client)
    translator = Translator(config=config.get("translation_settings", {}), cache_path=os.path.join(cache_path, "translation"), gemini_client=gemini_client)
    srt_generator = SRTGenerator(config=config.get("srt_settings", {}), cache_path=cache_path) # srt_generator might not need its own sub-cache

    # Ensure cache subdirectories exist
    for sub_dir in ["asr", "segmentation", "terminology", "translation"]:
        os.makedirs(os.path.join(cache_path, sub_dir), exist_ok=True)

    asr_output_segments = [] # Will hold list of dicts: {'text': ..., 'start_time': ..., 'end_time': ...}

    # 2. Pipeline execution based on mode
    if pipeline_mode == "full":
        print("Orchestrator: Running FULL pipeline (ASR -> ...)")
        # Run ASR
        # This is a placeholder; actual ASR output structure needs to be consistent
        asr_output_segments = asr_processor.transcribe(audio_file_path=input_path, source_language=source_lang)
        # Pass ASR output to Segmentation
        # For now, assuming segmentation takes the list of dicts from ASR
        segmented_text_for_terms = segmenter.process_segments(asr_output_segments)

    elif pipeline_mode == "srt_translate":
        print(f"Orchestrator: Running SRT_TRANSLATE pipeline for {input_path}")
        # Parse input SRT
        # Placeholder: In reality, use a proper SRT parser (like srtParser.js equivalent in Python)
        # to get text segments with timestamps.
        # For now, let's assume input_path is an SRT file and we read its content.
        # This part needs a robust SRT parser.
        print("Orchestrator: SRT parsing placeholder - assuming direct text for now.")
        # This is a crude placeholder for SRT parsing.
        # A real implementation would parse the SRT into timed segments.
        # For now, let's simulate that `asr_output_segments` would be populated by an SRT parser.
        # Example: asr_output_segments = parse_srt(input_path)
        # For the purpose of this placeholder, we'll just use a dummy segment.
        # If the input is an SRT, the `asr_output_segments` should be populated with its content.
        # The `segmenter.process_segments` expects a list of dicts with 'text'.
        # If we have an SRT, we need to convert it to that format first.
        # This is a simplification:
        with open(input_path, "r", encoding="utf-8") as f_srt:
            # Extremely basic "parser" for the dummy SRT file content
            # A real parser would handle timestamps and structure properly.
            # For now, just taking the text line.
            lines = f_srt.readlines()
            if len(lines) >=3: # Assuming "1 \n 00:00:00,000 --> ... \n Text"
                 # This is highly simplified and not robust for real SRTs.
                asr_output_segments = [{"text": lines[2].strip(), "start_time": 0.0, "end_time": 1.0}] # Dummy times
            else:
                asr_output_segments = [{"text": "Could not parse dummy SRT", "start_time": 0.0, "end_time": 1.0}]

        segmented_text_for_terms = segmenter.process_segments(asr_output_segments) # Process even for SRT

    else:
        print(f"Error: Unknown pipeline_mode: {pipeline_mode}")
        return f"{cache_path}/error_unknown_mode.txt"

    # 3. Pass segmented text to Terminology
    # segmented_text_for_terms is now a list of dicts like [{'text': 'segment1'}, {'text': 'segment2'}]
    extracted_terminology = terminologist.extract_terminology(segmented_text_for_terms)

    # 4. Pass segmented text and terminology to Translation
    # The translator expects a list of segments (text or dicts with 'text')
    translated_texts = translator.translate_batch(
        text_segments=segmented_text_for_terms, # This should be the final segments before translation
        source_lang=source_lang,
        target_lang=target_lang,
        terminology=extracted_terminology
    )

    # 5. Pass translated segments and timing to SRT Utils for final generation
    # We need to combine translated_texts with original/adjusted timings from asr_output_segments
    # This assumes a 1:1 mapping between asr_output_segments and translated_texts after segmentation.
    # This is a simplification; robust timestamp handling is complex.
    # If segmentation changes the number of segments, timestamps need careful re-alignment.

    final_srt_segments = []
    if len(asr_output_segments) == len(translated_texts): # Simplistic check
        for i, original_segment in enumerate(asr_output_segments):
            final_srt_segments.append({
                "text": translated_texts[i],
                "start_time": original_segment.get("start_time", 0.0), # Use original timings
                "end_time": original_segment.get("end_time", 1.0)    # Use original timings
            })
    else:
        print("Warning: Number of original segments and translated segments differ. Timestamps might be incorrect.")
        # Fallback: create segments with dummy timings if lengths don't match
        # This needs a much more sophisticated approach for real use.
        current_time = 0.0
        for i, text in enumerate(translated_texts):
            # Estimate duration based on text length (very crude)
            estimated_duration = len(text.split()) * 0.5  # 0.5s per word
            final_srt_segments.append({
                "text": text,
                "start_time": current_time,
                "end_time": current_time + max(1.0, estimated_duration) # Ensure at least 1s duration
            })
            current_time += max(1.0, estimated_duration) + 0.1 # Add small gap


    srt_content = srt_generator.generate_srt_content(final_srt_segments)

    final_srt_path = os.path.join(cache_path, "final_translated.srt")
    with open(final_srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)

    print(f"Pipeline finished. Output SRT: {final_srt_path}")
    return final_srt_path

if __name__ == '__main__':
    # This section is for testing the orchestrator directly.
    # In production, it will be called by the Electron app.
    mock_config = {
        "gemini_api_key": "YOUR_GEMINI_API_KEY_HERE", # IMPORTANT: Replace
        "gemini_settings": { # Settings for GeminiClient itself
            "model_name": "gemini-pro", # Default model for the client
            "temperature": 0.7
        },
        "asr_settings": {
            "model_size": "base",
            "device": "cpu", # Example
            "vad_threshold": 0.5,
            "demucs_enabled": False,
            "save_intermediate_output": True
        },
        "segmentation_settings": {
            "spacy_model_name": "en_core_web_sm", # For NLP part (if used)
            "max_split_length": 100, # For NLP part (if used)
            "meaning_split_num_parts": 2,
            "meaning_split_word_limit": 15,
            "language": "en", # Default language for prompts if not overridden by source_lang
            "save_intermediate_nlp_output": True,
            "save_intermediate_meaning_output": True
        },
        "terminology_settings": {
            "summary_length": "medium", # Example, actual use depends on prompt
            # source_language and target_language for prompts will be taken from run() args
            "existing_terms_info": "- example_term: ejemplo_termino (An existing term to exclude)",
            "save_intermediate_terminology": True,
            "save_intermediate_summary": True
        },
        "translation_settings": {
            # Contextual info like previous/subsequent content will be passed dynamically if available
            "save_intermediate_translation_output": True
        },
        "srt_settings": {
            "max_chars_per_line": 42 # Example for SRTGenerator
        },
        "cache_settings": { # General cache settings for the orchestrator
            "keep_intermediate_files": True
        }
    }

    # Create a dummy cache directory for testing the orchestrator specifically
    # Note: 'os' is already imported at the top of the file.
    dummy_cache_orchestrator_main = "./dummy_cache_orchestrator_main" # Main cache for this test run
    if not os.path.exists(dummy_cache_orchestrator_main):
        os.makedirs(dummy_cache_orchestrator_main)
    
    # Test full pipeline mode
    # Create a dummy input file for testing full pipeline
    # The ASR module's test creates its own dummy audio, this one is for the orchestrator's input_path
    dummy_input_audio_for_full_mode = os.path.join(dummy_cache_orchestrator_main, "orchestrator_dummy_audio.wav")
    with open(dummy_input_audio_for_full_mode, "w") as f: # Create an empty file, content doesn't matter for placeholders
        f.write("dummy audio content for orchestrator full mode test")

    print("\nTesting FULL pipeline mode (orchestrator)...")
    # Update mock_config for this run if needed, e.g., specific language for segmentation
    mock_config_full = mock_config.copy()
    mock_config_full["segmentation_settings"]["language"] = "en" # Explicitly set for this run
    mock_config_full["terminology_settings"]["source_language"] = "en"
    mock_config_full["terminology_settings"]["target_language"] = "es"

    run(
        input_path=dummy_input_audio_for_full_mode,
        target_lang="es", # This will be the main target_lang for translation
        source_lang="en", # This will be the main source_lang for ASR and prompts
        config=mock_config_full,
        cache_path=dummy_cache_orchestrator_main,
        pipeline_mode="full"
    )

    # Test SRT translate mode
    # Create a dummy input SRT file for testing srt_translate mode
    dummy_input_srt_for_translate_mode = os.path.join(dummy_cache_orchestrator_main, "orchestrator_dummy_input.srt")
    with open(dummy_input_srt_for_translate_mode, "w", encoding="utf-8") as f:
        f.write("1\n00:00:03,000 --> 00:00:05,000\nThis is a test sentence from orchestrator main for SRT mode.\n")

    print("\nTesting SRT_TRANSLATE pipeline mode (orchestrator)...")
    mock_config_srt = mock_config.copy()
    mock_config_srt["segmentation_settings"]["language"] = "en" # Assuming SRT is in English
    mock_config_srt["terminology_settings"]["source_language"] = "en"
    mock_config_srt["terminology_settings"]["target_language"] = "fr"

    run(
        input_path=dummy_input_srt_for_translate_mode,
        target_lang="fr", # This will be the main target_lang for translation
        source_lang="en", # Source lang of the SRT content
        config=mock_config_srt,
        cache_path=dummy_cache_orchestrator_main,
        pipeline_mode="srt_translate"
    )
    print(f"\nTo clean up, remove the directory: {dummy_cache_orchestrator_main}")