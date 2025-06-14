## Project: Advanced Translation Pipeline Integration

**Goal:** Replace the current video and SRT translation process in the Electron application with the enhanced pipeline from the foreign project, adapting it to use Gemini as the translation engine and integrating it smoothly with the existing application architecture.

**Key Decisions Incorporated:**

*   **Core Integration:** Python scripts will be refactored into a cohesive Python module/library.
*   **Translation Engine:** The 3-step Translate-Reflect-Adaptation prompting strategy (originally for GPT) will be adapted for Gemini and will be the default, always-enabled method.
*   **Intermediate Data:** Intermediate processing data will be cached in the application's user data directory.
*   **Configuration:** Python backend configurations will be merged into the Electron app's `settingsManager.js`.
*   **Python Environment:** Users will be expected to have a pre-configured Python environment; a `requirements.txt` will be provided.

---

### Phase 1: Python Backend Refactoring & Gemini Adaptation (Expanded)

**Objective:** Transform the foreign project's Python scripts (primarily from `./foreign/core/`) into a robust, callable Python library, and adapt its translation core to use the Gemini API with the 3-step prompting strategy. The focus will be on the ASR, text segmentation, summarization/terminology, and translation components. Scripts related to TTS/dubbing (e.g., `_8_1_audio_task.py` through `_12_dub_to_vid.py`, `tts_backend/`) and Streamlit utilities (`st_utils/`) are considered out of scope for this initial integration, unless explicitly needed for the core translation pipeline.

**1.1. Python Codebase Restructuring:**

*   **Task:** Analyze all relevant Python scripts from `./foreign/core/` and restructure them into a new Python package (e.g., `advanced_translator_pipeline`).
*   **Detailed Actions:**
    1.  **Establish Package Structure:**
        *   Create a main directory: `advanced_translator_pipeline/`
        *   Add an `__init__.py` to make it a package.
    2.  **Module Creation & Function Consolidation:**
        *   **`pipeline_orchestrator.py` (New):**
            *   This will be the main entry point for the Electron app to call.
            *   It will manage the overall workflow, calling other modules in sequence.
            *   It will replace the current sequential execution of `_1_ytdlp.py` (if video input), `_2_asr.py`, `_3_1_split_nlp.py`, `_3_2_split_meaning.py`, `_4_1_summarize.py`, `_4_2_translate.py`, and potentially parts of `_5_split_sub.py` and `_6_gen_sub.py` for final SRT generation.
            *   It will handle passing data (either in-memory objects or paths to cached intermediate files) between modules.
            *   It will accept configuration parameters (see 1.4) and the main input (video file path, audio file path, or pre-transcribed SRT data).
        *   **`asr_module.py` (Refactored from `./foreign/core/_2_asr.py`, `./foreign/core/asr_backend/`):**
            *   Consolidate ASR logic, primarily from `_2_asr.py`.
            *   Integrate relevant utilities from `asr_backend/audio_preprocess.py` (e.g., audio loading, VAD, chunking).
            *   Incorporate WhisperX logic from `asr_backend/whisperX_local.py` (or `whisperX_302.py` if preferred, assuming local execution is the target). Demucs for audio separation (`asr_backend/demucs_vl.py`) will also be part of this module if pre-processing requires it.
            *   The ElevenLabs ASR (`asr_backend/elevenlabs_asr.py`) will be noted but likely not implemented unless requested, to keep focus on the core WhisperX path.
            *   **Input:** Audio file path, language, ASR model settings.
            *   **Output:** Timestamped transcription data (e.g., list of segments with text, start, end times), potentially as a Pandas DataFrame or a list of Pydantic models.
        *   **`segmentation_module.py` (Refactored from `./foreign/core/_3_1_split_nlp.py`, `./foreign/core/_3_2_split_meaning.py`, `./foreign/core/spacy_utils/`):**
            *   **NLP-based Segmentation (from `_3_1_split_nlp.py`):**
                *   Integrate spaCy loading from `spacy_utils/load_nlp_model.py`.
                *   Incorporate splitting logic: `split_by_mark.py`, `split_by_comma.py`, `split_by_connector.py`, `split_long_by_root.py`.
                *   **Input:** ASR output (text segments).
                *   **Output:** Further segmented text chunks based on NLP rules.
            *   **Meaning-based Segmentation (from `_3_2_split_meaning.py`):**
                *   Adapt this to use Gemini (see 1.3). The original uses GPT via `utils/ask_gpt.py`.
                *   Prompts for meaning-based splitting (likely from `prompts.py`) will need to be reviewed and adapted for Gemini.
                *   **Input:** NLP-segmented chunks.
                *   **Output:** Semantically coherent text segments suitable for translation, adhering to constraints like Netflix subtitle style if desired.
        *   **`terminology_module.py` (Refactored from `./foreign/core/_4_1_summarize.py`):**
            *   Adapt summarization and terminology extraction logic.
            *   This module will also use Gemini (see 1.3), replacing GPT calls.
            *   Prompts for summarization/terminology (from `prompts.py`) will be adapted.
            *   **Input:** Meaning-segmented text.
            *   **Output:** Key terminology, summaries (if needed for context in translation).
        *   **`translation_module.py` (Refactored from `./foreign/core/_4_2_translate.py`, `./foreign/core/translate_lines.py`):**
            *   This is the core translation engine.
            *   Integrate the 3-step Translate-Reflect-Adaptation logic from `translate_lines.py`.
            *   This module will be heavily modified to use Gemini (see 1.3).
            *   It will use prompts from `prompts.py` (adapted for Gemini).
            *   **Input:** Meaning-segmented text, terminology, target language, source language.
            *   **Output:** Translated text segments.
        *   **`srt_utils_module.py` (Refactored from `./foreign/core/_5_split_sub.py`, `./foreign/core/_6_gen_sub.py` and potentially parts of `utils/models.py` related to subtitle formats):**
            *   Handle final SRT file generation, including re-combining translated segments with original or adjusted timestamps.
            *   Logic for splitting existing subtitles (`_5_split_sub.py`) might be adapted if the input is an SRT that needs re-segmentation before translation.
            *   Logic for generating subtitles (`_6_gen_sub.py`) will be key for the final output.
            *   **Input:** Translated text segments, original timing information (from ASR or input SRT).
            *   **Output:** Final SRT file content or path.
        *   **`common_utils.py` (Refactored from `./foreign/core/utils/`):**
            *   Consolidate genuinely reusable utility functions.
            *   `utils/decorator.py` might be used if applicable.
            *   `utils/pypi_autochoose.py` seems environment-specific and might be omitted or handled differently.
            *   `utils/onekeycleanup.py` logic might be integrated into the orchestrator for managing temporary files if any are still used before full cache integration.
            *   The existing `utils/models.py` contains Pydantic models for file paths and data structures; these will be reviewed. Path models will be superseded by dynamic cache paths (1.2). Data models (like `Sentence` or `SubtitleLine`) might be moved to relevant modules or a central `data_models.py`.
    3.  **Define Interfaces:**
        *   Use Python type hints and potentially Pydantic models for clear data contracts between modules and for the main orchestrator's input/output.
        *   Example: `pipeline_orchestrator.run(input_path: str, target_lang: str, config: dict) -> str: # Returns path to final SRT`
*   **Key Files Involved (Foreign Project - for refactoring into new structure):**
    *   Top-level scripts: `_1_ytdlp.py` (video download, if kept), `_2_asr.py`, `_3_1_split_nlp.py`, `_3_2_split_meaning.py`, `_4_1_summarize.py`, `_4_2_translate.py`, `translate_lines.py`, `prompts.py`, `_5_split_sub.py`, `_6_gen_sub.py`.
    *   Sub-directories: `asr_backend/` (esp. `audio_preprocess.py`, `whisperX_local.py`), `spacy_utils/`, `utils/` (esp. `ask_gpt.py`, `config_utils.py`, `models.py`).
*   **Output:** A new Python package directory: `advanced_translator_pipeline/` containing the modules described above.

**1.2. Intermediate Data Handling Refactoring:**

*   **Task:** Modify the new Python modules to use a structured cache in the application's user data directory, managed via paths provided by the Electron app.
*   **Detailed Actions:**
    1.  **Cache Path Injection:**
        *   The `pipeline_orchestrator.py` will accept a `base_cache_path` argument from the Electron app.
        *   It will then construct specific sub-paths for each step's intermediate output, e.g., `base_cache_path/asr_output/`, `base_cache_path/nlp_segments/`.
    2.  **Modify I/O Functions:**
        *   Functions like `save_results` in the (refactored) `asr_module.py` (originally `asr_backend/audio_preprocess.py`) will be changed to accept a full output path.
        *   Any direct file writes (e.g., to `_2_CLEANED_CHUNKS.xlsx`, `_3_1_SPLIT_BY_NLP.txt`) in the refactored modules will be replaced with functions that save to the provided cache paths.
        *   Data can be saved as JSON, Parquet (for DataFrames), text files, or other suitable formats. Consider using consistent naming conventions, possibly including timestamps or job IDs if concurrent processing is a future concern.
    3.  **Abstract `utils/models.py` Paths:**
        *   The file path definitions in `utils/models.py` (e.g., `LogJson`, `TransTxt`) will be removed or made dynamic. The responsibility for path generation will lie with the `pipeline_orchestrator.py` using the `base_cache_path`.
    4.  **Data Formats:**
        *   Pandas DataFrames: Can be saved as `.parquet` (efficient) or `.csv`/`.json`.
        *   Text data: `.txt` or `.json` (if structured).
        *   JSON data: `.json`.
*   **Key Files Involved (Foreign Project - for I/O changes):** Primarily the scripts that produce intermediate files: `_2_asr.py` (and `asr_backend/audio_preprocess.py`), `_3_1_split_nlp.py`, `_3_2_split_meaning.py`, `_4_1_summarize.py`. Also, `utils/models.py` for path definitions.

**1.3. Translation Engine Adaptation (Gemini):**

*   **Task:** Adapt the core translation logic (in the new `translation_module.py`) and other LLM-dependent steps (meaning-based segmentation, summarization) to use Gemini via the 3-step "Translate-Reflect-Adaptation" strategy, using the Python Gemini SDK.
*   **Detailed Actions:**
    1.  **Gemini API Interface (Python Gemini SDK):**
        *   Utilize Google's official Python client library (`google-generativeai`) for all Gemini interactions.
        *   The Gemini API key will be passed from Electron's `settingsManager.js` to the `pipeline_orchestrator.py` and then to the Gemini client.
    2.  **Create `gemini_client.py` (or integrate into `common_utils.py` or relevant modules):**
        *   This module will encapsulate all interactions with the Gemini API SDK.
        *   It will handle client initialization (with API key), prompt formatting, API calls (e.g., `generate_content`), error handling (retries, exceptions), and response parsing.
        *   It will replace the functionality of `./foreign/core/utils/ask_gpt.py`.
    3.  **Adapt Prompts (from `./foreign/core/prompts.py`):**
        *   Review `get_prompt_faithfulness`, `get_prompt_expressiveness`, and prompts for meaning-based segmentation (`_3_2_split_meaning.py`) and summarization (`_4_1_summarize.py`).
        *   Rewrite them to be optimal for Gemini, ensuring they clearly instruct the model for each step of the "Translate-Reflect-Adaptation" process:
            *   **Step 1: Translate (Faithfulness):**
                *   *Prompt Idea:* "Translate the following text from [SourceLang] to [TargetLang]. Prioritize literal accuracy and completeness: \n[Text to Translate]"
            *   **Step 2: Reflect (Self-Critique):**
                *   *Prompt Idea:* "Review the following [SourceLang] text and its [TargetLang] translation. Identify any awkward phrasing, unnatural expressions, or areas where fluency could be improved in the translation. Provide your critique: \nSource: [Original Text]\nTranslation: [Gemini's Step 1 Translation]"
            *   **Step 3: Adapt (Expressiveness):**
                *   *Prompt Idea:* "Based on the following critique, revise the [TargetLang] translation to be more natural, fluent, and culturally appropriate, while maintaining the original meaning. \nOriginal Text: [Original Text]\nInitial Translation: [Gemini's Step 1 Translation]\nCritique: [Gemini's Step 2 Output]\nRevised Translation:"
        *   Adapt prompts for meaning-based segmentation and summarization for Gemini.
    4.  **Update Calling Code:**
        *   In `segmentation_module.py` (for meaning-based segmentation), `terminology_module.py`, and `translation_module.py`, replace calls to `ask_gpt()` with calls to the new Gemini interface in `gemini_client.py`.
        *   Ensure the logic correctly sequences the 3-step translation calls.
    5.  **JSON Parsing:**
        *   If Gemini is used with JSON mode or expected to return structured JSON, ensure robust parsing. Assess if `json-repair` is still needed or if Gemini's SDK/output is reliable.
*   **Key Files Involved (Foreign Project):** `translate_lines.py`, `_4_2_translate.py`, `_3_2_split_meaning.py`, `_4_1_summarize.py`, `prompts.py`, `utils/ask_gpt.py`.

**1.4. Configuration Integration Preparation:**

*   **Task:** Identify all configurable parameters from the foreign Python codebase and modify the new Python modules to accept them from the `pipeline_orchestrator.py`.
*   **Detailed Actions:**
    1.  **Identify Parameters:**
        *   Scan refactored modules for uses of `load_key()` from `utils/config_utils.py`.
        *   Parameters: ASR model names/paths, language codes, VAD thresholds, Demucs settings, spaCy model name, sentence length limits, meaning-based splitting parameters, summary length, terminology parameters, Gemini settings (temperature), debug flags.
    2.  **Modify Code to Accept Config Dictionary:**
        *   Remove direct calls to `load_key()` or `config.yaml`.
        *   `pipeline_orchestrator.py`'s main function accepts a `config_dict`.
        *   The orchestrator passes relevant subsets/values to modules. Example: `asr_module.process_audio(audio_path, config=config_dict['asr_settings'])`.
*   **Key Files Involved (Foreign Project):** Scripts using `utils/config_utils.load_key()`. `utils/config_utils.py` will be deprecated.

**1.5. Testing (Python Backend):**

*   **Task:** Ensure the reliability and correctness of the refactored Python backend modules and the overall pipeline.
*   **Detailed Actions:**
    1.  **Unit Testing (Pytest):**
        *   Write unit tests for each new Python module (`asr_module.py`, `segmentation_module.py`, `terminology_module.py`, `translation_module.py`, `srt_utils_module.py`, `gemini_client.py`).
        *   Test individual functions for various inputs, outputs, and edge cases.
        *   Mock external dependencies (e.g., file system for I/O heavy functions, Gemini API calls in `gemini_client.py` to test prompt formatting and response handling logic without actual API calls).
    2.  **Integration Testing (Python Backend - Pytest):**
        *   Test the `pipeline_orchestrator.py`'s ability to manage the workflow:
            *   Call modules in the correct sequence.
            *   Ensure data (in-memory or cached file paths) is passed correctly between modules.
        *   Test with sample audio/text inputs, mocking the Electron app's provision of configuration and cache paths.
        *   Verify that intermediate data is correctly written to and read from the (mocked or temporary) cache directory by different modules.
        *   Validate the structure and content of the final output (e.g., generated SRT file).
    3.  **Gemini Interaction Testing:**
        *   For `gemini_client.py` and modules using it:
            *   Test prompt construction for all 3 steps of translation, meaning-based segmentation, and summarization.
            *   Test handling of successful Gemini API responses (parsing, data extraction).
            *   Test handling of Gemini API errors (exceptions, retries if implemented).
    4.  **Error Handling & Robustness:**
        *   Test how individual modules and the orchestrator handle invalid inputs, missing models/files (where applicable before Electron passes valid paths), and unexpected data.
    5.  **Cache I/O Validation:**
        *   Specifically test that modules correctly save their outputs to the designated cache paths and that subsequent modules can correctly load these outputs.
        *   Verify data formats used for caching (Parquet, JSON, TXT).
*   **Tools:** Pytest framework, `unittest.mock` for mocking.

---

### Phase 2: Electron Application Integration (Expanded)

**Objective:** Integrate the refactored Python backend (`advanced_translator_pipeline`) into the Electron application, manage its execution via a dedicated service, update application workflows, handle configuration, and refine the UI/UX.

**2.1. Python Backend Invocation Service:**

*   **Task:** Create or adapt an Electron service to manage the invocation of the `advanced_translator_pipeline`.
*   **Detailed Actions:**
    1.  **Create `AdvancedTranslationService.js` (New Service):**
        *   Responsible for spawning `pipeline_orchestrator.py`.
        *   Similar to [`src/transcriptionService.js`](src/transcriptionService.js:1) but for the new pipeline.
        *   **Methods:** `startFullPipeline(...)`, `startSrtTranslationPipeline(...)`.
    2.  **Python Process Management:**
        *   Use Node.js `child_process.spawn`.
        *   Ensure correct Python interpreter usage.
        *   Manage `stdout`, `stderr`, `exit` events.
    3.  **Data Marshalling (Electron to Python):**
        *   Inputs (file paths, SRT content via stdin/temp file, langs, JSON config string, `baseCachePath`) passed as command-line arguments.
        *   Example command: `python path/to/advanced_translator_pipeline/pipeline_orchestrator.py --input_file "..." --target_lang "..." --config_json "{...}" --cache_path "..." --pipeline_mode "..."`
    4.  **Result Handling (Python to Electron):**
        *   Python prints final SRT path/content to `stdout`. `AdvancedTranslationService.js` captures it.
    5.  **Progress Reporting (Optional but Recommended):**
        *   Python prints structured JSON progress to `stdout`. `AdvancedTranslationService.js` parses and emits IPC events.
*   **Key Files Involved (Current App):** [`src/main.js`](src/main.js:1), [`src/transcriptionService.js`](src/transcriptionService.js:1) (as template).
*   **Output:** New `AdvancedTranslationService.js`.

**2.2. Workflow Adaptation in `VideoProcessingCoordinator`, `GlobalFileAdmissionController`, and `SimplifiedTranslationManager`:**

*   **Task:** Modify core application logic in [`src/main.js`](src/main.js:1) to integrate `AdvancedTranslationService.js`.
*   **Detailed Actions:**
    1.  **`VideoProcessingCoordinator`:**
        *   After video input/current ASR, invoke `AdvancedTranslationService.startFullPipeline()`.
        *   If existing ASR is replaced, VPC directly initiates the new full pipeline.
    2.  **`GlobalFileAdmissionController` (GFC):**
        *   Route video/audio to VPC (then `AdvancedTranslationService.js`).
        *   Route SRT files to a handler using `AdvancedTranslationService.startSrtTranslationPipeline()`.
    3.  **`SimplifiedTranslationManager`:**
        *   Role may shift to primarily delegate to `AdvancedTranslationService.js`.
    4.  **SRT Batch Processing Handlers:**
        *   Update to use `AdvancedTranslationService.startSrtTranslationPipeline()` per file.
    5.  **Event Handling and UI Updates:**
        *   Use IPC channels ([`src/ipcChannels.js`](src/ipcChannels.js:1)) for status/progress/results/errors to [`src/renderer.js`](src/renderer.js:1).
        *   New events: `ADVANCED_TRANSLATION_START/PROGRESS/COMPLETE/ERROR`.
*   **Key Files Involved (Current App):** [`src/main.js`](src/main.js:1), [`src/ipcChannels.js`](src/ipcChannels.js:1).

**2.3. Configuration Management with `settingsManager.js`:**

*   **Task:** Extend [`src/settingsManager.js`](src/settingsManager.js:1) for Python backend configs and update UI.
*   **Detailed Actions:**
    1.  **Define New Settings:**
        *   Add keys like `pythonPipeline.asrModelSize`, `pythonPipeline.spacyModelName`, `pythonPipeline.maxSegmentLengthNLP`, `pythonPipeline.geminiSettings.temperature`, `pythonPipeline.cacheSettings.keepIntermediateFiles`.
        *   Gemini API key remains managed by `settingsManager.js`.
    2.  **UI for Settings ([`src/renderer.js`](src/renderer.js:1), [`src/index.html`](src/index.html:1)):**
        *   Add new fields/sections in settings panel.
    3.  **Loading and Passing Settings:**
        *   `AdvancedTranslationService.js` retrieves `pythonPipeline` settings, serializes to JSON, passes to Python.
*   **Key Files Involved (Current App):** [`src/settingsManager.js`](src/settingsManager.js:1), [`src/renderer.js`](src/renderer.js:1), [`src/index.html`](src/index.html:1).

**2.4. User Interface (UI) and User Experience (UX) Updates:**

*   **Task:** Adapt UI in [`src/renderer.js`](src/renderer.js:1) and [`src/index.html`](src/index.html:1).
*   **Detailed Actions:**
    1.  **Process Feedback:** Clear indicators, progress updates, success/error messages.
    2.  **Simplification:** Remove UI for old translation choices if new pipeline is default.
    3.  **Output Access:** Consider access to job cache directory if intermediate files are kept.
    4.  **Help and Documentation Links:** Update tooltips, help sections.
*   **Key Files Involved (Current App):** [`src/renderer.js`](src/renderer.js:1), [`src/index.html`](src/index.html:1), [`src/index.css`](src/index.css:1).

**2.5. Testing (Electron Integration & Initial E2E):**

*   **Task:** Verify the successful integration of the Python backend with the Electron application and conduct initial end-to-end tests.
*   **Detailed Actions:**
    1.  **Electron Service Testing (`AdvancedTranslationService.js`):**
        *   Test correct spawning of the Python `pipeline_orchestrator.py`.
        *   Verify accurate data marshalling: passing of file paths, configurations (as JSON string), language parameters, and cache path to the Python script.
        *   Test handling of results from Python: capturing `stdout` for the final SRT path/content.
        *   Test error capturing: parsing `stderr` from Python and propagating errors.
        *   If progress reporting is implemented, test parsing of progress messages and emission of IPC events.
    2.  **Workflow Integration Testing (in [`src/main.js`](src/main.js:1)):**
        *   Test that `VideoProcessingCoordinator`, `GlobalFileAdmissionController`, and SRT batch handlers correctly invoke the new `AdvancedTranslationService.js` with appropriate parameters.
        *   Ensure the application flow proceeds as expected after the service completes (e.g., displaying results, handling errors).
    3.  **Configuration Testing:**
        *   Verify that settings modified in the UI via [`src/settingsManager.js`](src/settingsManager.js:1) are correctly passed to the Python backend and that the backend behaves as expected with different configurations.
    4.  **UI Feedback Testing (in [`src/renderer.js`](src/renderer.js:1)):**
        *   Test that progress indicators, status messages, success notifications, and error alerts are displayed correctly in the UI based on IPC events from the main process.
    5.  **Initial End-to-End (E2E) Scenario Testing:**
        *   Conduct E2E tests for core user scenarios using the Electron application's UI:
            *   **Video-to-Translated-SRT:** Process a few sample videos of different types/lengths.
            *   **Direct-SRT-to-Translated-SRT:** Process a few sample SRT files.
        *   Verify the overall functionality: file input, processing initiation, progress display (if any), final output generation and display/saving, and error handling through the UI.
        *   Focus on the "happy path" and a few common error conditions.
    6.  **Cache Path Validation (Electron side):**
        *   Ensure Electron correctly generates and passes a valid `baseCachePath` to the Python script.
        *   If UI allows access to cache, test this functionality.
*   **Tools:** Manual testing through the Electron app UI. Developer tools for inspecting IPC messages and console logs.

---

### Phase 3: Finalization, Broader Testing, and Documentation

**Objective:** Ensure the integrated `advanced_translator_pipeline` is highly robust, performs well across diverse scenarios, is thoroughly documented, and ready for users.

**3.1. Final Comprehensive E2E & Performance Testing:**

*   **Task:** Conduct extensive end-to-end testing covering a wide range of inputs, edge cases, and performance benchmarks.
*   **Detailed Actions:**
    1.  **Expanded E2E User Scenario Testing:**
        *   **Video-to-Translated-SRT:** Test with a diverse set of videos: various formats (MP4, MKV, MOV), lengths (short clips to longer videos), audio qualities (clear speech, noisy backgrounds, multiple speakers), different source/target languages.
        *   **Direct-SRT-to-Translated-SRT:** Test with diverse SRTs: varying line counts, complex timings, different encodings (if applicable), SRTs from different sources.
        *   Verify ASR accuracy, segmentation quality, terminology relevance, and final translation quality (fluency, accuracy, naturalness) across all scenarios.
    2.  **Comprehensive Error Handling & Edge Case Testing:**
        *   Test system behavior with invalid/corrupt input files.
        *   Simulate Python script errors (e.g., by temporarily breaking a Python module) to ensure Electron handles them gracefully.
        *   Simulate Gemini API errors (e.g., network issues, invalid API key temporarily) to test retry mechanisms (if any) and error reporting.
        *   Test with unusual configurations or empty inputs.
    3.  **Performance Benchmarking:**
        *   Measure processing time for various input types and lengths.
        *   Identify any performance bottlenecks in either the Python backend or Electron frontend.
        *   Profile Python code if specific slowdowns are detected.
    4.  **Resource Usage:**
        *   Monitor CPU, memory, and disk space usage during processing.
    5.  **Cache Robustness:**
        *   Test concurrent job processing (if this is a supported scenario) and ensure cache isolation.
        *   Test behavior when cache directory is not writable (permissions issues).
        *   Verify cleanup of temporary/intermediate files if `keepIntermediateFiles` is false.

**3.2. Python Dependencies and `requirements.txt`:**

*   **Task:** Finalize and document Python dependencies.
*   **Detailed Actions:**
    1.  **Dependency Audit:** Review all Python modules in `advanced_translator_pipeline`, list `import` statements.
    2.  **Version Pinning:** Select specific, stable versions for core dependencies. Generate `requirements.txt` from a clean virtual environment.
        ```
        pandas==X.Y.Z
        spacy==A.B.C
        # spacy models to be installed separately via spacy download
        google-generativeai==P.Q.R
        whisperx==D.E.F
        # torch, torchaudio, torchvision (often specific to CUDA or CPU)
        # demucs
        # json-repair (if kept)
        ```
    3.  **Python Version:** Specify recommended Python version (e.g., Python 3.9+).
    4.  **Model Downloads:** Document separately any models needing download post-pip-install (spaCy models, WhisperX models).
*   **Output:** A finalized `requirements.txt` and clear setup instructions.

**3.3. Documentation Updates:**

*   **Task:** Update all relevant documentation for users and developers.
*   **Detailed Actions:**
    1.  **User Documentation (README.md, in-app help):**
        *   Explain new pipeline benefits and high-level workflow.
        *   Detailed Python environment setup: Python install, venv, `requirements.txt`, model downloads.
        *   UI guide for new features and settings.
        *   Troubleshooting common issues.
    2.  **Developer Documentation (code comments, internal wikis):**
        *   Architecture of `advanced_translator_pipeline`.
        *   API docs for `AdvancedTranslationService.js`.
        *   IPC communication details.
        *   Data flow diagrams.
        *   Extension/modification notes.
*   **Key Files Involved:** `README.md`, new `.md` guides.

**3.4. Cross-Platform Considerations (if applicable):**

*   **Task:** Evaluate and test compatibility on other operating systems if broader support is planned.
*   **Detailed Actions:**
    1.  **Identify Platform-Specific Code:** Review Python and Node.js code for OS-dependent paths, commands, or libraries.
    2.  **Testing Environment Setup:** Prepare testing environments for target platforms (e.g., macOS, Linux).
    3.  **Targeted Testing:** Execute key E2E scenarios on each target platform.
    4.  **Documentation:** Update setup and troubleshooting guides with platform-specific instructions.

---

### Visual Plan: High-Level Integrated Workflow

```mermaid
graph TD
    subgraph Electron App (UI/Main Process)
        direction LR
        A[User Input: Video/SRT File] --> B{renderer.js / main.js};
        B --> C(VideoProcessingCoordinator / SRTBatchProcessor);
        C --> D(AdvancedTranslationService.js);
        D -- IPC: Start Python Pipeline with Config --> E[PythonOrchestrator.py];
        E -- Returns Final SRT Path/Content --> D;
        D --> F(GFC/VPC for Finalization);
        F --> G[User: Translated SRT Output];
    end

    subgraph Python Backend (Refactored Library)
        direction TB
        E --> P1[Module: ASR (WhisperX, Demucs)];
        P1 -- Cleaned Chunks (User Data Cache) --> P2[Module: Text Segmentation (spaCy)];
        P2 -- NLP Segments (User Data Cache) --> P3[Module: Meaning Segmentation (Gemini)];
        P3 -- Meaning Segments (User Data Cache) --> P4[Module: Summarization & Terminology (Gemini)];
        P4 -- Terminology (User Data Cache) --> P5[Module: Core Translation (Gemini 3-Step)];
        P3 -- Meaning Segments (User Data Cache) --> P5;
        P5 -- Raw Translated Sentences --> P6[Module: Timestamp Alignment & Final SRT Gen];
        P6 -- Final SRT --> E;
    end

    subgraph Configuration & Data
        H[settingsManager.js] -.-> D;
        I[User Data Directory Cache] <--> P1;
        I <--> P2;
        I <--> P3;
        I <--> P4;
    end

    classDef electron fill:#D6EAF8,stroke:#3498DB,stroke-width:2px;
    classDef python fill:#D5F5E3,stroke:#2ECC71,stroke-width:2px;
    classDef data fill:#FCF3CF,stroke:#F1C40F,stroke-width:2px;

    class A,B,C,D,F,G electron;
    class E,P1,P2,P3,P4,P5,P6 python;
    class H,I data;
```

---