"""
Prompt Adaptation Module for the Advanced Translation Pipeline.

This module is responsible for generating prompts tailored for Gemini,
based on the structures and intentions found in the original foreign project's
prompts.py.

It will provide functions to generate prompts for:
1. Meaning-based text splitting.
2. Summarization and terminology extraction.
3. The 3-step translation process (Faithfulness, Reflect, Adapt).
"""

def get_gemini_split_prompt(sentence: str, num_parts: int = 2, word_limit: int = 20, language: str = "English") -> str:
    """
    Generates a prompt for Gemini to split a sentence for subtitles.
    Adapted from foreign/core/prompts.py - get_split_prompt.
    """
    # Note: The original prompt requested two alternative approaches and a choice.
    # For Gemini, we might simplify this or adjust based on observed Gemini strengths.
    # For now, let's aim for a direct split instruction expecting a single best approach.
    prompt = f"""\
## Role
You are a professional Netflix subtitle splitter in **{language}**.

## Task
Split the given subtitle text into **{num_parts}** parts. Each part should ideally be less than **{word_limit}** words.

Key Objectives:
1.  Maintain sentence meaning coherence according to Netflix subtitle standards.
2.  Strive for parts that are roughly equal in length (minimum 3 words each, if possible).
3.  Split at natural breaking points like punctuation marks or conjunctions.
4.  If the provided text consists of repeated words, split them in the middle.

## Given Text
<split_this_sentence>
{sentence}
</split_this_sentence>

## Output Format
Provide your output in JSON format only, with no other text.
The JSON should contain a key "analysis" with a brief description of your splitting rationale,
and a key "split_parts" which is an array of strings, where each string is a part of the split sentence.

Example:
```json
{{
    "analysis": "Split after the main clause to maintain coherence.",
    "split_parts": [
        "This is the first part",
        "and this is the second part."
    ]
}}
```

Note: Start your answer with ```json and end with ```.
"""
    return prompt.strip()

def get_gemini_summary_terminology_prompt(source_content: str, src_lang: str, tgt_lang: str, existing_terms_info: str = "") -> str:
    """
    Generates a prompt for Gemini to summarize text and extract terminology.
    Adapted from foreign/core/prompts.py - get_summary_prompt.
    """
    terms_note_section = ""
    if existing_terms_info:
        terms_note_section = f"\n### Existing Terms\nPlease exclude these terms in your extraction:\n{existing_terms_info}"

    prompt = f"""\
## Role
You are a video translation expert and terminology consultant, specializing in {src_lang} comprehension and {tgt_lang} expression optimization.

## Task
For the provided {src_lang} video text:
1.  Summarize the main topic in two concise sentences.
2.  Extract up to 10-15 key professional terms or names. For each term:
    a.  Provide its {tgt_lang} translation (or keep the original if it's a proper noun best left untranslated or if no direct equivalent exists).
    b.  Provide a brief explanation of the term in {tgt_lang} (or {src_lang} if more appropriate for the explanation's clarity).
    c.  Exclude any terms listed in the "Existing Terms" section below.
{terms_note_section}

## Input Text
<text>
{source_content}
</text>

## Output Format
Provide your output in JSON format only, with no other text.
The JSON should have two main keys: "theme" and "terms".
"theme" should be a string containing the two-sentence summary.
"terms" should be an array of objects, each object having "src" (original term), "tgt" (translation/original), and "note" (explanation).

Example:
```json
{{
  "theme": "This video discusses advancements in AI. It highlights breakthroughs in medical diagnostics.",
  "terms": [
    {{
      "src": "Machine Learning",
      "tgt": "机器学习",
      "note": "Core AI technique for intelligent decisions via data training."
    }},
    {{
      "src": "Deep Blue",
      "tgt": "Deep Blue",
      "note": "Chess-playing computer developed by IBM."
    }}
  ]
}}
```

Note: Start your answer with ```json and end with ```.
"""
    return prompt.strip()

def _generate_translation_context_prompt(previous_content: str, subsequent_content: str, summary: str, notes: str) -> str:
    """
    Helper to generate the shared context block for translation prompts.
    Adapted from foreign/core/prompts.py - generate_shared_prompt.
    """
    # Ensure None inputs are handled as empty strings to avoid "None" in prompt
    previous_content = previous_content or "N/A"
    subsequent_content = subsequent_content or "N/A"
    summary = summary or "N/A"
    notes = notes or "N/A"

    return f"""\
### Contextual Information
<previous_utterances>
{previous_content}
</previous_utterances>

<subsequent_utterances>
{subsequent_content}
</subsequent_utterances>

### Overall Summary of the Content
{summary}

### Specific Points to Note for this Segment
{notes}
""".strip()


def get_gemini_translation_faithfulness_prompt(lines_to_translate: str, src_lang: str, tgt_lang: str, context_prompt: str) -> str:
    """
    Generates the 'Faithfulness' prompt for Gemini (Step 1 of 3-step translation).
    Adapted from foreign/core/prompts.py - get_prompt_faithfulness.
    """
    # The original prompt dynamically created a JSON structure for the output.
    # For Gemini, we can instruct it to produce a simpler JSON array of translations
    # or a JSON object mapping original lines to translated lines.
    # Let's aim for a list of translated strings, assuming lines_to_translate is a block of text with newlines.
    
    prompt = f"""\
## Role
You are a professional subtitle translator, fluent in both {src_lang} and {tgt_lang}, and their respective cultures.
Your primary goal is to produce a direct and faithful translation.

## Task
Translate the provided {src_lang} subtitle lines into {tgt_lang}.
Focus on accurately conveying the original meaning of each line.
Consider the provided context and any relevant professional terminology.

{context_prompt}

## Translation Principles
1.  **Faithful to Original:** Accurately convey content and meaning. Do not add, omit, or arbitrarily change content.
2.  **Accurate Terminology:** Use professional terms correctly and consistently.
3.  **Understand Context:** Comprehend and reflect background and contextual relationships.

## Input Subtitle Lines
<subtitles>
{lines_to_translate}
</subtitles>

## Output Format
Provide your output in JSON format only, with no other text.
The JSON should be an array of strings, where each string is the translated version of the corresponding input line.
If the input has multiple lines, the output array should have the same number of translated lines in the same order.

Example for input with two lines:
```json
[
  "Translated version of the first line.",
  "Translated version of the second line."
]
```

Note: Start your answer with ```json and end with ```.
"""
    return prompt.strip()

def get_gemini_translation_reflect_adapt_prompt(original_lines: str, direct_translations: list, src_lang: str, tgt_lang: str, context_prompt: str) -> str:
    """
    Generates the 'Reflect & Adapt' prompt for Gemini (Steps 2 & 3 of 3-step translation).
    Adapted from foreign/core/prompts.py - get_prompt_expressiveness.
    This combines reflection and final adaptation into one prompt for Gemini.
    """
    # direct_translations is a list of strings from the faithfulness step.
    # We need to present this clearly to Gemini.
    
    formatted_direct_translations = "\n".join([f"- \"{dt}\"" for dt in direct_translations])

    prompt = f"""\
## Role
You are a professional Netflix subtitle translator and language consultant, expert in {src_lang} and {tgt_lang}.
Your goal is to refine a direct {tgt_lang} translation to make it natural, fluent, and culturally appropriate for the target audience.

## Task
You are given original {src_lang} subtitle lines and their direct {tgt_lang} translations.
Your task is to:
1.  **Reflect:** Analyze the direct translations. Identify issues in naturalness, fluency, style consistency, or conciseness.
2.  **Adapt:** Based on your reflection, provide improved {tgt_lang} translations that are natural, fluent, and stylistically appropriate.

{context_prompt}

## Input
<original_subtitles_{src_lang}>
{original_lines}
</original_subtitles_{src_lang}>

<direct_translations_{tgt_lang}>
{formatted_direct_translations}
</direct_translations_{tgt_lang}>

## Guidelines for Adaptation
-   **Naturalness & Fluency:** Prioritize smooth, idiomatic {tgt_lang}.
-   **Conciseness:** Ensure subtitles are not overly wordy.
-   **Style:** Match the language style to the content's theme (e.g., casual for tutorials, formal for documentaries).
-   **Clarity:** Ensure the translation is easily understood by a {tgt_lang} audience.
-   **No Comments:** The final translations should not contain any explanatory comments.
-   **No Empty Lines:** Ensure all original lines have a corresponding translated line.

## Output Format
Provide your output in JSON format only, with no other text.
The JSON should contain two keys:
1.  `reflection`: A brief string summarizing your analysis of the direct translations and the key areas for improvement.
2.  `final_translations`: An array of strings, representing the improved {tgt_lang} translations, corresponding to the order of the original lines.

Example:
```json
{{
  "reflection": "The direct translations were a bit too literal and missed some idiomatic expressions. The tone also needed adjustment for a documentary style.",
  "final_translations": [
    "Improved translation of the first line.",
    "Improved translation of the second line."
  ]
}}
```

Note: Start your answer with ```json and end with ```.
"""
    return prompt.strip()


if __name__ == '__main__':
    print("--- Testing Meaning Split Prompt ---")
    split_p = get_gemini_split_prompt("This is a rather long sentence that we definitely want to split into two parts for better readability.", num_parts=2, word_limit=15, language="English")
    print(split_p)

    print("\n--- Testing Summary/Terminology Prompt ---")
    summary_terms_p = get_gemini_summary_terminology_prompt(
        source_content="This video is about artificial intelligence and machine learning. We explore various algorithms like neural networks and decision trees.",
        src_lang="English",
        tgt_lang="Spanish",
        existing_terms_info="- Neural Network: Red Neuronal (A type of ML model)"
    )
    print(summary_terms_p)

    print("\n--- Testing Translation Context Prompt ---")
    context_p = _generate_translation_context_prompt(
        previous_content="Speaker A: How are you?\nSpeaker B: I'm fine.",
        subsequent_content="Speaker A: That's good to hear.",
        summary="A casual conversation about well-being.",
        notes="The tone is informal."
    )
    print(context_p)

    print("\n--- Testing Translation Faithfulness Prompt ---")
    faith_p = get_gemini_translation_faithfulness_prompt(
        lines_to_translate="Hello world.\nHow are you today?",
        src_lang="English",
        tgt_lang="Spanish",
        context_prompt=context_p
    )
    print(faith_p)

    print("\n--- Testing Translation Reflect & Adapt Prompt ---")
    reflect_adapt_p = get_gemini_translation_reflect_adapt_prompt(
        original_lines="Hello world.\nHow are you today?",
        direct_translations=["Hola mundo.", "¿Cómo estás hoy?"],
        src_lang="English",
        tgt_lang="Spanish",
        context_prompt=context_p
    )
    print(reflect_adapt_p)