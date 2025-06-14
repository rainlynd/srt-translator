"""
Text Segmentation Module for the advanced translation pipeline.

This module will be responsible for:
- NLP-based segmentation (using spaCy, refactoring logic from _3_1_split_nlp.py and spacy_utils/).
- Meaning-based segmentation (using Gemini, refactoring logic from _3_2_split_meaning.py).

It will take ASR output (or pre-segmented text) and produce more refined segments
suitable for translation.
"""

# Placeholder for imports (e.g., spacy, or models from gemini_client)
import os
import json
from .prompt_adapter import get_gemini_split_prompt # Import the new prompt generator

class TextSegmenter:
    def __init__(self, config: dict, cache_path: str, gemini_client=None):
        """
        Initializes the TextSegmenter.

        Args:
            config (dict): Configuration dictionary for segmentation settings
                           (e.g., spaCy model, meaning-based segmentation prompts/params).
            cache_path (str): Path to the cache directory for intermediate segmentation files.
            gemini_client: An instance of the Gemini client for meaning-based segmentation.
                           (This will be passed from the orchestrator).
        """
        self.config = config
        self.cache_path = cache_path
        self.gemini_client = gemini_client
        print(f"TextSegmenter initialized with config: {self.config}, cache_path: {self.cache_path}")
        # Initialize spaCy model based on config
        # self.nlp = spacy.load(config.get("spacy_model_name", "en_core_web_sm"))

    def segment_nlp(self, text_segments: list) -> list:
        """
        Performs NLP-based segmentation on text segments.

        Args:
            text_segments (list): A list of text strings or dictionaries 
                                  (e.g., from ASR output).
                                  Example: [{'text': 'Sentence one. Sentence two.'}, ...]

        Returns:
            list: A list of further segmented text chunks based on NLP rules.
                  Example: [{'text': 'Sentence one.'}, {'text': 'Sentence two.'}, ...]
        """
        print(f"TextSegmenter: Performing NLP segmentation on {len(text_segments)} segments.")
        
        nlp_segmented_chunks = []
        # Placeholder for NLP segmentation logic:
        # - Iterate through text_segments.
        # - Apply spaCy-based splitting rules (from spacy_utils like split_by_mark, etc.).
        # - Accumulate results.
        for segment in text_segments:
            # This is a very basic placeholder
            original_text = segment.get("text", segment) if isinstance(segment, dict) else segment
            sentences = original_text.split(". ") # Grossly simplified
            for s in sentences:
                if s.strip():
                    nlp_segmented_chunks.append({"text": s.strip() + ("." if not s.endswith(".") else "")})
        
        if self.config.get("save_intermediate_nlp_output", True):
            output_filename = "nlp_segmented_chunks.json"
            output_path = os.path.join(self.cache_path, output_filename)
            try:
                os.makedirs(self.cache_path, exist_ok=True)
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(nlp_segmented_chunks, f, indent=4, ensure_ascii=False)
                print(f"TextSegmenter: Saved NLP segmented chunks to {output_path}")
            except Exception as e:
                print(f"TextSegmenter: Error saving NLP segmented chunks to {output_path}: {e}")

        print(f"TextSegmenter: NLP segmentation resulted in {len(nlp_segmented_chunks)} chunks.")
        return nlp_segmented_chunks

    def segment_meaning(self, nlp_segments: list) -> list:
        """
        Performs meaning-based segmentation on NLP-segmented chunks using Gemini.

        Args:
            nlp_segments (list): A list of text chunks from NLP segmentation.
                                 Example: [{'text': 'A long sentence to be split by meaning.'}, ...]

        Returns:
            list: A list of semantically coherent text segments.
                  Example: [{'text': 'A long sentence'}, {'text': 'to be split by meaning.'}, ...]
        """
        if not self.gemini_client:
            print("TextSegmenter: Gemini client not provided. Skipping meaning-based segmentation.")
            return nlp_segments

        print(f"TextSegmenter: Performing meaning-based segmentation on {len(nlp_segments)} NLP segments.")
        
        meaning_segmented_output = []
        # Placeholder for meaning-based segmentation logic:
        # - Iterate through nlp_segments.
        # - Construct prompts for Gemini (based on prompts.py and adapted for Gemini).
        # - Call self.gemini_client.generate_content(...)
        # - Parse Gemini's response to get semantically split segments.
        # - Accumulate results.

        # Default parameters for splitting, can be overridden by self.config
        num_parts = self.config.get("meaning_split_num_parts", 2)
        word_limit = self.config.get("meaning_split_word_limit", 20)
        # Assuming language is passed or determined, placeholder for now
        language = self.config.get("language", "English")

        for chunk_item in nlp_segments:
            original_text = chunk_item.get("text", chunk_item) if isinstance(chunk_item, dict) else chunk_item
            
            prompt = get_gemini_split_prompt(
                sentence=original_text,
                num_parts=num_parts,
                word_limit=word_limit,
                language=language
            )
            
            try:
                response_str = self.gemini_client.generate_content(prompt)
                # Attempt to parse the JSON response
                # Gemini might return a string that needs to be cleaned (e.g., remove ```json ... ```)
                if response_str.strip().startswith("```json"):
                    response_str = response_str.strip()[7:-3].strip() # Remove markdown code block
                
                response_json = json.loads(response_str)
                split_parts = response_json.get("split_parts", [])
                analysis = response_json.get("analysis", "")
                print(f"TextSegmenter: Meaning split analysis for '{original_text[:30]}...': {analysis}")

                for part in split_parts:
                    meaning_segmented_output.append({"text": part}) # Store as dicts with 'text' key
            except json.JSONDecodeError as e:
                print(f"TextSegmenter: Error decoding JSON from Gemini for meaning split: {e}. Response: {response_str}")
                meaning_segmented_output.append({"text": original_text}) # Fallback to original chunk
            except Exception as e:
                print(f"TextSegmenter: Error during meaning segmentation for chunk '{original_text[:30]}...': {e}")
                meaning_segmented_output.append({"text": original_text}) # Fallback

        if self.config.get("save_intermediate_meaning_output", True) and self.gemini_client:
            output_filename = "meaning_segmented_output.json"
            output_path = os.path.join(self.cache_path, output_filename)
            try:
                os.makedirs(self.cache_path, exist_ok=True)
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(meaning_segmented_output, f, indent=4, ensure_ascii=False)
                print(f"TextSegmenter: Saved meaning segmented output to {output_path}")
            except Exception as e:
                print(f"TextSegmenter: Error saving meaning segmented output to {output_path}: {e}")

        print(f"TextSegmenter: Meaning-based segmentation resulted in {len(meaning_segmented_output)} segments.")
        return meaning_segmented_output

    def process_segments(self, asr_output: list) -> list:
        """
        Full segmentation process: NLP followed by meaning-based segmentation.

        Args:
            asr_output (list): Timestamped transcription data from ASR.
                               Example: [{'text': 'Segment one. Segment two.', 'start_time': ..., 'end_time': ...}, ...]

        Returns:
            list: Final list of text segments ready for translation.
        """
        print("TextSegmenter: Starting full segmentation process.")
        # For now, assuming asr_output contains 'text' field to be segmented.
        # Timestamps might need to be carried through or re-aligned later.
        
        texts_to_segment = [item['text'] for item in asr_output if 'text' in item] # Or adapt if structure is different

        nlp_chunks = self.segment_nlp(texts_to_segment)
        final_segments = self.segment_meaning(nlp_chunks)
        
        # Here, one would typically re-associate timestamps if possible, or prepare
        # the segments in a way that srt_utils_module can handle them.
        # For simplicity, returning list of dicts with 'text'.
        
        print("TextSegmenter: Full segmentation process complete.")
        return final_segments


if __name__ == '__main__':
    mock_segmentation_config = {
        "spacy_model_name": "en_core_web_sm", # Example
        "meaning_segmentation_prompt_template": "Split this for subtitles: {text}", # This specific key is not used by get_gemini_split_prompt directly
        "meaning_split_num_parts": 2,
        "meaning_split_word_limit": 15,
        "language": "English",
        "save_intermediate_nlp_output": True,
        "save_intermediate_meaning_output": True
    }
    dummy_cache_segmentation_test_dir = "./dummy_cache_segmentation_module_test" # More specific name
    # import os # Already imported at the top
    if not os.path.exists(dummy_cache_segmentation_test_dir):
        os.makedirs(dummy_cache_segmentation_test_dir)

    # Mock Gemini client for testing
    class MockGeminiClient:
        def generate_content(self, prompt): # Corresponds to GeminiClient.generate_content
            print(f"MockGeminiClient: Received prompt for meaning split (first 70 chars): {prompt[:70]}...")
            # Simulate the JSON output format expected by get_gemini_split_prompt
            # Extract the sentence from the prompt for mocking purposes
            sentence_marker = "<split_this_sentence>\n"
            sentence_end_marker = "\n</split_this_sentence>"
            try:
                start_idx = prompt.find(sentence_marker) + len(sentence_marker)
                end_idx = prompt.find(sentence_end_marker)
                original_sentence = prompt[start_idx:end_idx].strip()
            except:
                original_sentence = "Could not parse sentence from mock prompt"

            # Simple mock split
            parts = original_sentence.split(" ") # Split by space
            mid_point = len(parts) // 2
            part1 = " ".join(parts[:mid_point])
            part2 = " ".join(parts[mid_point:])
            
            mock_response = {
                "analysis": f"Mock analysis: Split '{original_sentence[:20]}...' into two parts.",
                "split_parts": [part1, part2] if part1 and part2 else [original_sentence]
            }
            # Return as a JSON string, as the main code expects to parse it
            return json.dumps(mock_response)

    segmenter = TextSegmenter(
        config=mock_segmentation_config,
        cache_path=dummy_cache_segmentation_test_dir,
        gemini_client=MockGeminiClient() # Provide the mock client
    )

    mock_asr_data = [
        {"text": "This is the first sentence. It is quite long and might need splitting.", "start_time": 0.0, "end_time": 5.0},
        {"text": "A second segment. Shorter this time.", "start_time": 5.5, "end_time": 8.0}
    ]
    
    print("\nTesting TextSegmenter with mock ASR data...")
    final_segmented_text = segmenter.process_segments(mock_asr_data)
    print(f"Final Segments: {final_segmented_text}")

    # Check if output files were created
    expected_nlp_file = os.path.join(dummy_cache_segmentation_test_dir, "nlp_segmented_chunks.json")
    if os.path.exists(expected_nlp_file):
        print(f"Intermediate NLP output file created at: {expected_nlp_file}")
    else:
        print(f"Error: Intermediate NLP output file NOT found at: {expected_nlp_file}")

    expected_meaning_file = os.path.join(dummy_cache_segmentation_test_dir, "meaning_segmented_output.json")
    if os.path.exists(expected_meaning_file):
        print(f"Intermediate meaning output file created at: {expected_meaning_file}")
    else:
        print(f"Error: Intermediate meaning output file NOT found at: {expected_meaning_file}")

    print(f"\nTo clean up, remove the directory: {dummy_cache_segmentation_test_dir}")