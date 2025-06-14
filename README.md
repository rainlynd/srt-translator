# SRT Translator

SRT Translator is an Electron-based desktop application designed for transcribing video files to SRT subtitles and translating SRT files using AI-powered services (Google Gemini).

## Table of Contents

- [SRT Translator](#srt-translator)
  - [Table of Contents](#table-of-contents)
  - [Key Features](#key-features)
    - [SRT File Translation](#srt-file-translation)
    - [Video Transcription \& Translation](#video-transcription--translation)
    - [User Interface](#user-interface)
    - [Configuration](#configuration)
    - [Processing \& Control](#processing--control)
  - [Prerequisites](#prerequisites)
  - [Setup and Installation](#setup-and-installation)
    - [For End-Users (Packaged Application)](#for-end-users-packaged-application)
    - [For Developers](#for-developers)
  - [Running the Application](#running-the-application)
    - [End-Users](#end-users)
    - [Developers (Development Mode)](#developers-development-mode)
  - [Usage Guide](#usage-guide)
  - [Building the Application (for Developers)](#building-the-application-for-developers)
  - [Acknowledgements](#acknowledgements)
  - [License](#license)

## Key Features

### SRT File Translation
*   Select individual or multiple `.srt` files, or entire directories (with recursive file discovery).
*   AI-driven translation using Google Gemini models (configurable primary and retry models).
*   Customizable target language, system prompts, and AI parameters (temperature, Top-P).
*   Context-aware translation using previous text segments.
*   Option to skip translation if source and target languages are identical.

### Video Transcription & Translation
*   Select individual or multiple video files (e.g., .mp4, .mkv), or entire directories (with recursive file discovery).
*   Audio extraction using FFmpeg.
*   Transcription via WhisperX (for non-Chinese languages) and FunASR (for Chinese language audio).
*   Configurable source language (or auto-detect), compute type, and other transcription parameters.
*   Speaker diarization support (typically for 1-2 speakers, requires a Hugging Face user access token for non-Chinese diarization).
*   Translation of generated SRTs using the same AI pipeline as SRT file translation.
*   Option to perform transcription only by selecting "None - Disable Translation" as the target language.

### User Interface
*   Intuitive tabbed interface: "Translate Videos", "Translate SRT", "Log", and "Settings".
*   File management lists with real-time status (Pending, Processing, Success, Error, etc.) and progress bars.
*   Global controls for common settings like target language, video source language, diarization enablement, and recursive file selection.

### Configuration
*   Persistent settings stored locally for API keys (Google Gemini), AI model selection, and various translation/transcription parameters.
*   Option to load default application settings.

### Processing & Control
*   Robust job queuing and concurrency management for handling multiple files.
*   API rate limiting (RPM - Requests Per Minute, TPM - Tokens Per Minute) for Google Gemini.
*   In-app log display for monitoring operational messages, warnings, and errors.
*   Ability to cancel ongoing batch processing for both SRT and video tasks.
*   "Retry" functionality for files that failed or were cancelled.
*   "Hold-to-activate" mechanism for starting SRT translation batches to prevent accidental clicks.

## Prerequisites

*   **Node.js:** Required for running and developing the application.
*   **Python:** Required for the transcription backend.
*   **FFmpeg:** Must be installed and accessible in the system's PATH or bundled with the application (the Python script attempts to locate a bundled version first).
*   **(For Developers) Git:** For cloning the repository.

## Setup and Installation

### For End-Users (Packaged Application)
1.  Download the latest release for your operating system from the [Releases Page](https://github.com/rainlynd/srt-translator/releases)
2.  Install the application following standard procedures for your OS.
3.  Launch SRT Translator.
4.  Navigate to the **Settings** tab.
5.  Enter your **Google Gemini API Key**.
6.  (Optional) If you plan to use speaker diarization for non-Chinese languages, enter your **Hugging Face User Access Token**.

### For Developers
1.  Clone the repository:
    ```bash
    git clone https://github.com/rainlynd/srt-translator.git
    ```
    (Replace with actual repository URL)
2.  Navigate to the project directory:
    ```bash
    cd srt-translator
    ```
3.  Install Node.js dependencies:
    ```bash
    npm install
    ```
4.  Set up the Python virtual environment and install Python dependencies:
    ```bash
    npm run setup:python_env
    ```
    This script creates a `.venv` and installs packages from [`requirements_dev.txt`](requirements_dev.txt:1).
5.  Ensure FFmpeg is installed and accessible in your system PATH.
6.  **API Key Configuration:**
    *   Run the application once (`npm run dev`).
    *   Navigate to the **Settings** tab to enter your Google Gemini API Key.
    *   (Optional) Enter your Hugging Face User Access Token if needed.
    *   Alternatively, you can manually create/edit the `settings.json` file in the application's user data directory (its location varies by OS; the structure can be inferred from [`src/settingsManager.js`](src/settingsManager.js:1)).

## Running the Application

### End-Users
*   Launch the installed SRT Translator application from your applications menu or desktop shortcut.

### Developers (Development Mode)
*   Execute the following command in the project root:
    ```bash
    npm run dev
    ```
    This command first ensures the Python environment is set up and then starts the Electron application with hot-reloading.

## Usage Guide

1.  **Global Controls:** Before starting any processing, configure the **Target Language** and, for videos, the **Source Language** (or leave as "Auto-detect") and **Enable Diarization** if needed. The "Select Files Recursively" checkbox changes file/directory selection behavior.
2.  **Translate Videos Tab:**
    *   Click "Select Video File(s)" (or "Select Video Directory" if recursive selection is enabled).
    *   Selected videos will appear in the list.
    *   Click "Start Queue" to begin transcription and then translation for all pending videos.
    *   Use "Cancel All" to stop the entire video processing batch.
    *   Individual files can be removed (before processing) or retried (after failure/cancellation).
3.  **Translate SRT Tab:**
    *   Click "Select SRT File(s)" (or "Select SRT Directory" if recursive selection is enabled).
    *   Selected SRT files will appear.
    *   **Hold** the "Start Translations" button for 3 seconds to initiate the batch translation.
    *   Use "Cancel All" to stop the SRT translation batch.
4.  **Log Tab:**
    *   View real-time application logs, including progress updates, informational messages, warnings, and errors.
5.  **Settings Tab:**
    *   Configure your Google Gemini API Key and select primary/retry Gemini models.
    *   Adjust the System Prompt for the AI.
    *   Set translation parameters (Temperature, Top P, Entries per Chunk, Chunk Retries, RPM).
    *   Configure transcription settings (Compute Type, Hugging Face Token for diarization, Condition on Previous Text, Threads).
    *   Save your settings or load default values.

## Building the Application (for Developers)

*   **Package the application (without creating installers):**
    ```bash
    npm run package
    ```
*   **Create distributable installers/packages:**
    ```bash
    npm run make
    ```
    The build artifacts will be located in the `out/` directory.

## Acknowledgements

This application is made possible by leveraging several powerful open-source projects and services:

*   **Google Gemini:** For advanced AI-powered translation capabilities.
*   **WhisperX by @m-bain:** For highly accurate speech-to-text transcription and word-level alignment. ([GitHub](https://github.com/m-bain/whisperX))
*   **FunASR by Alibaba Group:** For robust Chinese speech recognition. ([GitHub](https://github.com/modelscope/FunASR))
*   **FFmpeg:** For versatile and efficient audio and video processing. ([Website](https://ffmpeg.org/))
*   **Electron & Node.js:** For the cross-platform desktop application framework.
*   **pyannote.audio:** For speaker diarization. ([GitHub](https://github.com/pyannote/pyannote-audio))

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
