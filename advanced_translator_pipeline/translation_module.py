"""
Core Translation Module for the advanced translation pipeline.

This module will be responsible for:
- Implementing the 3-step Translate-Reflect-Adaptation translation strategy using Gemini.
- Taking segmented text and (optionally) terminology as input.
- Outputting translated text segments.

It will refactor logic from:
- ./foreign/core/_4_2_translate.py
- ./foreign/core/translate_lines.py
- ./foreign/core/prompts.py (for translation-specific prompts)
"""

# Placeholder for imports (e.g., models from gemini_client)
import os
import json
from .prompt_adapter import (
    _generate_translation_context_prompt,
    get_gemini_translation_faithfulness_prompt,
    get_gemini_translation_reflect_adapt_prompt
)

class Translator:
    def __init__(self, config: dict, cache_path: str, gemini_client):
        """
        Initializes the Translator.

        Args:
            config (dict): Configuration dictionary for translation settings
                           (e.g., prompt templates for each step, Gemini model parameters).
            cache_path (str): Path to the cache directory for intermediate translation files.
            gemini_client: An instance of the Gemini client.
        """
        self.config = config
        self.cache_path = cache_path
        self.gemini_client = gemini_client
        if not self.gemini_client:
            raise ValueError("Gemini client must be provided to Translator.")
        print(f"Translator initialized with config: {self.config}, cache_path: {self.cache_path}")

    def translate_segment(self, text_segment: str, source_lang: str, target_lang: str,
                          previous_content: str = None, subsequent_content: str = None,
                          summary: str = None, notes: str = None,
                          terminology: dict = None) -> str:
        """
        Translates a single text segment using the 3-step strategy.

        Args:
            text_segment (str): The text segment to translate.
            source_lang (str): Source language code.
            target_lang (str): Target language code.
            terminology (dict, optional): Extracted terminology to aid translation.
            previous_content (str, optional): Text from previous segments for context.
            subsequent_content (str, optional): Text from subsequent segments for context.
            summary (str, optional): Overall summary of the content.
            notes (str, optional): Specific notes for this segment.

        Returns:
            str: The translated text segment.
        """
        print(f"Translator: Translating segment: '{text_segment[:50]}...' from {source_lang} to {target_lang}")
        if terminology: # Terminology might be incorporated into the context_prompt or specific prompts
            print(f"Translator: Using terminology (info): {terminology}")

        # Construct shared context prompt
        # Notes might include terminology if structured that way.
        context_prompt_str = _generate_translation_context_prompt(
            previous_content, subsequent_content, summary, notes
        )

        # Step 1: Translate (Faithfulness)
        prompt_faithfulness = get_gemini_translation_faithfulness_prompt(
            lines_to_translate=text_segment, # Assuming single segment for now, or adapt if it's multiple lines
            src_lang=source_lang,
            tgt_lang=target_lang,
            context_prompt=context_prompt_str
        )
        
        initial_translations_list = [f"Error in Step 1 for: {text_segment}"] # Default error
        try:
            response_str_step1 = self.gemini_client.generate_content(prompt_faithfulness)
            if response_str_step1.strip().startswith("```json"):
                response_str_step1 = response_str_step1.strip()[7:-3].strip()
            
            # Expects a list of strings, even if lines_to_translate was a single line
            parsed_response_step1 = json.loads(response_str_step1)
            if isinstance(parsed_response_step1, list) and len(parsed_response_step1) > 0:
                initial_translations_list = parsed_response_step1
            else: # Fallback if JSON is not a list or empty
                initial_translations_list = [str(parsed_response_step1)] # Convert to string list
            print(f"Translator (Step 1 - Faithfulness Output): {initial_translations_list}")
        except json.JSONDecodeError as e:
            print(f"Translator: Error decoding JSON from Gemini for Step 1: {e}. Response: {response_str_step1}")
        except Exception as e:
            print(f"Translator: Error during Step 1 (Faithfulness): {e}")

        # Step 2 & 3: Reflect & Adapt
        # The prompt_adapter's get_gemini_translation_reflect_adapt_prompt expects original_lines (string)
        # and direct_translations (list of strings).
        prompt_reflect_adapt = get_gemini_translation_reflect_adapt_prompt(
            original_lines=text_segment, # The original segment/lines
            direct_translations=initial_translations_list, # List from step 1
            src_lang=source_lang,
            tgt_lang=target_lang,
            context_prompt=context_prompt_str
        )

        final_translation = f"Error in Step 2/3 for: {text_segment}" # Default error
        try:
            response_str_step23 = self.gemini_client.generate_content(prompt_reflect_adapt)
            if response_str_step23.strip().startswith("```json"):
                response_str_step23 = response_str_step23.strip()[7:-3].strip()

            parsed_response_step23 = json.loads(response_str_step23)
            reflection = parsed_response_step23.get("reflection", "No reflection provided.")
            final_translations_list = parsed_response_step23.get("final_translations", [])
            
            if final_translations_list and isinstance(final_translations_list, list) and len(final_translations_list) > 0:
                final_translation = "\n".join(final_translations_list) # Join if multiple lines returned
            # If final_translations_list is empty or not a list, final_translation remains its default error string
            # No explicit else needed here if the default error string is already set.

            print(f"Translator (Step 2 - Reflection): {reflection}")
            print(f"Translator (Step 3 - Adapt Output): {final_translation}")
        except json.JSONDecodeError as e:
            print(f"Translator: Error decoding JSON from Gemini for Step 2/3: {e}. Response: {response_str_step23}")
        except Exception as e:
            print(f"Translator: Error during Step 2/3 (Reflect/Adapt): {e}")
        
        return final_translation

    def translate_batch(self, text_segments: list, source_lang: str, target_lang: str,
                        terminology: dict = None,
                        # Contexts for the whole batch, if applicable
                        batch_previous_content: str = None,
                        batch_subsequent_content: str = None,
                        batch_summary: str = None,
                        batch_notes: str = None) -> list:
        """
        Translates a batch of text segments.

        Args:
            text_segments (list): A list of text segments (strings or dicts with 'text' field).
            source_lang (str): Source language code.
            target_lang (str): Target language code.
            terminology (dict, optional): Extracted terminology.
            batch_previous_content (str, optional): Context before the entire batch.
            batch_subsequent_content (str, optional): Context after the entire batch.
            batch_summary (str, optional): Summary relevant to the entire batch.
            batch_notes (str, optional): Notes relevant to the entire batch.

        Returns:
            list: A list of translated text segments (strings).
        """
        translated_batch = []
        # For simplicity, this example passes the same batch-level context to each segment.
        # More sophisticated context handling might involve providing segment-specific context.
        for i, segment_item in enumerate(text_segments):
            text_to_translate = segment_item.get("text", segment_item) if isinstance(segment_item, dict) else segment_item
            
            # Potentially derive segment-specific context here if needed, e.g.,
            # prev_seg_text = text_segments[i-1]['text'] if i > 0 else batch_previous_content
            # next_seg_text = text_segments[i+1]['text'] if i < len(text_segments) - 1 else batch_subsequent_content

            translated_text = self.translate_segment(
                text_segment=text_to_translate,
                source_lang=source_lang,
                target_lang=target_lang,
                terminology=terminology, # Terminology might be part of notes or context_prompt
                previous_content=batch_previous_content, # Simplified: using batch context
                subsequent_content=batch_subsequent_content, # Simplified
                summary=batch_summary, # Simplified
                notes=batch_notes      # Simplified
            )
            translated_batch.append(translated_text)
            # Individual segment saving could be done here if needed, or batch save after loop.
        
        if self.config.get("save_intermediate_translation_output", True):
            output_filename = "translated_segments_batch.json"
            output_path = os.path.join(self.cache_path, output_filename)
            try:
                os.makedirs(self.cache_path, exist_ok=True)
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(translated_batch, f, indent=4, ensure_ascii=False)
                print(f"Translator: Saved translated batch to {output_path}")
            except Exception as e:
                print(f"Translator: Error saving translated batch to {output_path}: {e}")

        return translated_batch

if __name__ == '__main__':
    mock_translation_config = {
        "gemini_model": "gemini-pro", # Example, used by GeminiClient if configured there
        # Prompt templates are now sourced from prompt_adapter.py, so this key might be less relevant
        # unless we want to allow overriding them via config.
        "prompt_templates": {},
        "save_intermediate_translation_output": True
    }
    dummy_cache_translation_test_dir = "./dummy_cache_translation_module_test" # More specific name
    # import os # Already imported at the top
    if not os.path.exists(dummy_cache_translation_test_dir):
        os.makedirs(dummy_cache_translation_test_dir)

    class MockGeminiClient: # Copied from terminology_module for standalone testing
        def generate_content(self, prompt_text):
            print(f"MockGeminiClient: Received prompt for translation (first 70 chars): {prompt_text[:70]}...")
            if "Translate the provided" in prompt_text and "Faithful" in prompt_text: # Step 1
                # Simulate JSON array output
                mock_response_step1 = ["Mocked faithful translation line 1.", "Mocked faithful translation line 2."]
                return json.dumps(mock_response_step1)
            elif "Reflect & Adapt" in prompt_text and "direct translations" in prompt_text: # Step 2/3
                mock_response_step23 = {
                    "reflection": "Mocked reflection: Direct translation was okay but could be more fluent.",
                    "final_translations": ["Mocked adapted translation line 1.", "Mocked adapted translation line 2."]
                }
                return json.dumps(mock_response_step23)
            return json.dumps({"error": "Unknown mock prompt type for translation"})

    translator = Translator(
        config=mock_translation_config,
        cache_path=dummy_cache_translation_test_dir,
        gemini_client=MockGeminiClient()
    )

    mock_segments_to_translate = [
        {"text": "Hello world, this is a test."},
        {"text": "Another sentence for translation."}
    ]
    mock_terms = {"world": "planeta"}

    print("\nTesting translation batch...")
    translated_results = translator.translate_batch(
        text_segments=mock_segments_to_translate,
        source_lang="en",
        target_lang="es",
        terminology=mock_terms,
        batch_summary="This is a test batch about hellos and how are yous.", # Added for testing
        batch_notes="Keep translations informal." # Added for testing
    )
    print(f"Translated Batch: {translated_results}")

    # Check if output file was created
    expected_translation_file = os.path.join(dummy_cache_translation_test_dir, "translated_segments_batch.json")
    if os.path.exists(expected_translation_file):
        print(f"Intermediate translation output file created at: {expected_translation_file}")
    else:
        print(f"Error: Intermediate translation output file NOT found at: {expected_translation_file}")

    print(f"\nTo clean up, remove the directory: {dummy_cache_translation_test_dir}")