import os
import tkinter as tk
from tkinter import messagebox, filedialog

# --- Configuration ---
# List of video file extensions to look for.
VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m4v', '.webm'}

# The name of the output file that will list missing subtitles.
# This file will be saved in the same directory as the script.
OUTPUT_FILENAME = 'missing_subtitles.txt'
# --- End Configuration ---


def find_missing_subtitles(scan_path: str) -> list:
    """
    Recursively scans the given path for video files missing .srt subtitles.
    This function correctly handles Unicode filenames (e.g., Chinese, Japanese, Korean).

    Args:
        scan_path: The absolute path to the directory to scan.

    Returns:
        A list of full paths to video files that are missing subtitles.
    """
    missing_subtitle_files = []
    print(f"🔍 Starting scan in folder: '{scan_path}'...")

    # os.walk handles Unicode paths and filenames automatically in Python 3.
    for root, _, files in os.walk(scan_path):
        video_files = {}  # { 'basename': 'full_path' }
        subtitle_basenames = set()

        for filename in files:
            basename, ext = os.path.splitext(filename)
            ext_lower = ext.lower()

            if ext_lower in VIDEO_EXTENSIONS:
                video_files[basename] = os.path.join(root, filename)
            elif ext_lower == '.srt':
                subtitle_basenames.add(basename)

        # For each video, check if a matching subtitle exists (case-insensitive)
        for video_basename, video_fullpath in video_files.items():
            found_match = False
            for sub_basename in subtitle_basenames:
                if sub_basename.lower().startswith(video_basename.lower()):
                    found_match = True
                    break
            if not found_match:
                missing_subtitle_files.append(video_fullpath)

    return missing_subtitle_files


def show_results_popup(missing_files: list, output_filepath: str):
    """
    Displays a pop-up with the scan results and saves the list to a file if needed.
    """
    # Create a simple Tkinter window to host the message box
    root = tk.Tk()
    root.withdraw()  # Hide the main window

    if not missing_files:
        title = "Scan Complete"
        message = "✅ All video files have corresponding subtitle files."
        messagebox.showinfo(title, message)
        return

    count = len(missing_files)
    file_saved_message = ""

    # Save the list of missing files to the output text file using UTF-8 encoding
    try:
        # Using encoding='utf-8' ensures CJK characters are saved correctly.
        file_content = "\n".join(missing_files)
        with open(output_filepath, 'w', encoding='utf-8') as f:
            f.write(file_content)
        file_saved_message = f"A list of {count} files has been saved to:\n'{output_filepath}'"
    except IOError as e:
        file_saved_message = f"Error saving file: {e}"

    # Display the final pop-up message
    title = "Missing Subtitles Found!"
    popup_message = f"Found {count} video(s) without subtitles.\n\n{file_saved_message}"

    messagebox.showwarning(title, popup_message)
    root.destroy()


def main():
    """
    Main function to run the subtitle check.
    """
    root = tk.Tk()
    root.withdraw()

    # Ask the user to select a directory to scan
    messagebox.showinfo("Select Folder", "Please select the folder you want to scan for videos.")
    scan_dir = filedialog.askdirectory(title="Select Video Folder to Scan")

    # If the user closes the dialog box without choosing a folder
    if not scan_dir:
        print("No folder selected. Exiting script.")
        return

    missing_files = find_missing_subtitles(scan_dir)
    print("✅ Scan complete.")

    # Save the output file to the same directory as the script
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_file_path = os.path.join(script_dir, OUTPUT_FILENAME)
    
    show_results_popup(missing_files, output_file_path)


if __name__ == "__main__":
    main()
