"""
Terminology Extraction and Summarization Module for the advanced translation pipeline.

This module will be responsible for:
- Processing segmented text to extract key terminology.
- Generating summaries if needed for contextual understanding during translation.
- Using Gemini for these LLM-dependent tasks (refactoring logic from _4_1_summarize.py).
"""

# Placeholder for imports (e.g., models from gemini_client)
import os
import json
from .prompt_adapter import get_gemini_summary_terminology_prompt # Import the new prompt generator

class TerminologyExtractor:
    def __init__(self, config: dict, cache_path: str, gemini_client=None):
        """
        Initializes the TerminologyExtractor.

        Args:
            config (dict): Configuration dictionary for terminology settings
                           (e.g., prompt templates, summary length).
            cache_path (str): Path to the cache directory for intermediate terminology files.
            gemini_client: An instance of the Gemini client.
        """
        self.config = config
        self.cache_path = cache_path
        self.gemini_client = gemini_client
        print(f"TerminologyExtractor initialized with config: {self.config}, cache_path: {self.cache_path}")

    def extract_terminology(self, text_segments: list) -> dict:
        """
        Extracts key terminology from a list of text segments using Gemini.

        Args:
            text_segments (list): A list of text segments (strings or dicts with 'text' field).
                                  Example: [{'text': 'An important concept is mentioned here.'}, ...]

        Returns:
            dict: A dictionary of extracted terms, possibly with definitions or context.
                  Example: {"important concept": "A key idea discussed in the text."}
        """
        if not self.gemini_client:
            print("TerminologyExtractor: Gemini client not provided. Skipping terminology extraction.")
            return {}

        print(f"TerminologyExtractor: Extracting terminology from {len(text_segments)} segments.")

        source_content = "\n".join([seg.get("text", seg) if isinstance(seg, dict) else seg for seg in text_segments])
        
        # Assuming src_lang and tgt_lang are available in self.config or passed differently
        # For now, let's make them configurable or use defaults.
        src_lang = self.config.get("source_language", "English")
        tgt_lang = self.config.get("target_language", "English") # Target for term translations
        existing_terms_info = self.config.get("existing_terms_info", "") # Placeholder for actual existing terms

        prompt = get_gemini_summary_terminology_prompt(
            source_content=source_content,
            src_lang=src_lang,
            tgt_lang=tgt_lang,
            existing_terms_info=existing_terms_info
        )

        extracted_terms = {}
        try:
            response_str = self.gemini_client.generate_content(prompt)
            if response_str.strip().startswith("```json"):
                response_str = response_str.strip()[7:-3].strip()
            
            response_json = json.loads(response_str)
            extracted_terms = response_json.get("terms", {}) # Expecting a list of term objects
            # The prompt asks for a list of objects, so ensure this is handled.
            # For simplicity, if it's a list, we'll keep it as a list.
            # If the mock or actual response gives a dict, this will take it.
            # The return type hint is dict, so this might need adjustment based on final prompt/response.

        except json.JSONDecodeError as e:
            print(f"TerminologyExtractor: Error decoding JSON from Gemini for terminology: {e}. Response: {response_str}")
        except Exception as e:
            print(f"TerminologyExtractor: Error during terminology extraction: {e}")

        # Save terminology to cache_path if configured
        if self.config.get("save_intermediate_terminology", True) and self.gemini_client:
            output_filename = "extracted_terminology.json"
            output_path = os.path.join(self.cache_path, output_filename)
            try:
                os.makedirs(self.cache_path, exist_ok=True)
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(extracted_terms, f, indent=4, ensure_ascii=False)
                print(f"TerminologyExtractor: Saved extracted terminology to {output_path}")
            except Exception as e:
                print(f"TerminologyExtractor: Error saving extracted terminology to {output_path}: {e}")
        
        print(f"TerminologyExtractor: Terminology extraction complete. Found {len(extracted_terms)} terms.")
        return extracted_terms # This is now a list of dicts

    def summarize_text(self, text_segments: list) -> str:
        """
        Generates a summary for the given text segments using Gemini.

        Args:
            text_segments (list): A list of text segments.

        Returns:
            str: A summary of the text.
        """
        if not self.gemini_client:
            print("TerminologyExtractor: Gemini client not provided. Skipping summarization.")
            return "Summary not available."

        print(f"TerminologyExtractor: Generating summary for {len(text_segments)} segments.")

        source_content = "\n".join([seg.get("text", seg) if isinstance(seg, dict) else seg for seg in text_segments])
        
        src_lang = self.config.get("source_language", "English")
        tgt_lang = self.config.get("target_language", "English") # Target for term translations, also context for summary
        existing_terms_info = self.config.get("existing_terms_info", "")

        prompt = get_gemini_summary_terminology_prompt(
            source_content=source_content,
            src_lang=src_lang,
            tgt_lang=tgt_lang,
            existing_terms_info=existing_terms_info # The same prompt can be used; we'll extract the 'theme'
        )

        summary = "Summary not available due to error."
        try:
            response_str = self.gemini_client.generate_content(prompt)
            if response_str.strip().startswith("```json"):
                response_str = response_str.strip()[7:-3].strip()
            
            response_json = json.loads(response_str)
            summary = response_json.get("theme", "Summary could not be extracted from response.")
        except json.JSONDecodeError as e:
            print(f"TerminologyExtractor: Error decoding JSON from Gemini for summary: {e}. Response: {response_str}")
        except Exception as e:
            print(f"TerminologyExtractor: Error during summarization: {e}")

        # Save summary to cache_path if configured
        if self.config.get("save_intermediate_summary", True) and self.gemini_client:
            output_filename = "summary.txt"
            output_path = os.path.join(self.cache_path, output_filename)
            try:
                os.makedirs(self.cache_path, exist_ok=True)
                with open(output_path, "w", encoding="utf-8") as f:
                    f.write(summary)
                print(f"TerminologyExtractor: Saved summary to {output_path}")
            except Exception as e:
                print(f"TerminologyExtractor: Error saving summary to {output_path}: {e}")
        
        print(f"TerminologyExtractor: Summarization complete.")
        return summary

if __name__ == '__main__':
    mock_terminology_config = {
        "terminology_prompt_template": "Extract key terms from: {text}", # Not directly used by get_gemini_summary_terminology_prompt
        "summary_length": "short", # Example parameter, could be used inside the prompt if needed
        "source_language": "English",
        "target_language": "Spanish",
        "save_intermediate_terminology": True,
        "save_intermediate_summary": True
    }
    dummy_cache_terminology_test_dir = "./dummy_cache_terminology_module_test" # More specific name
    # import os # Already imported at the top
    if not os.path.exists(dummy_cache_terminology_test_dir):
        os.makedirs(dummy_cache_terminology_test_dir)

    # Mock Gemini client for testing
    class MockGeminiClient:
        def generate_content(self, prompt): # Corresponds to GeminiClient.generate_content
            print(f"MockGeminiClient: Received prompt for summary/terms (first 70 chars): {prompt[:70]}...")
            # Simulate the JSON output format expected by get_gemini_summary_terminology_prompt
            mock_response = {
                "theme": "This is a mocked theme/summary about the input.",
                "terms": [
                    {"src": "mock_src_term1", "tgt": "mock_tgt_term1", "note": "Note for term1"},
                    {"src": "mock_src_term2", "tgt": "mock_tgt_term2", "note": "Note for term2"}
                ]
            }
            return json.dumps(mock_response) # Return as a JSON string

    terminator = TerminologyExtractor(
        config=mock_terminology_config,
        cache_path=dummy_cache_terminology_test_dir,
        gemini_client=MockGeminiClient()
    )

    mock_segments_for_terms = [
        {"text": "The quick brown fox jumps over the lazy dog."},
        {"text": "Artificial intelligence is a rapidly evolving field."}
    ]
    
    print("\nTesting terminology extraction...")
    terms = terminator.extract_terminology(mock_segments_for_terms)
    print(f"Extracted Terms: {terms}")

    print("\nTesting summarization...")
    summary_result = terminator.summarize_text(mock_segments_for_terms)
    print(f"Summary: {summary_result}")

    # Check if output files were created
    expected_terms_file = os.path.join(dummy_cache_terminology_test_dir, "extracted_terminology.json")
    if os.path.exists(expected_terms_file):
        print(f"Intermediate terminology file created at: {expected_terms_file}")
    else:
        print(f"Error: Intermediate terminology file NOT found at: {expected_terms_file}")

    expected_summary_file = os.path.join(dummy_cache_terminology_test_dir, "summary.txt")
    if os.path.exists(expected_summary_file):
        print(f"Intermediate summary file created at: {expected_summary_file}")
    else:
        print(f"Error: Intermediate summary file NOT found at: {expected_summary_file}")

    print(f"\nTo clean up, remove the directory: {dummy_cache_terminology_test_dir}")