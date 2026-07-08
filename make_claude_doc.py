import os

# 클로드에게 보여줄 필요가 없는 무거운 부품 폴더나 숨김 폴더 제외 목록
EXCLUDE_DIRS = ['node_modules', '.git', '.github', '__pycache__']
EXCLUDE_FILES = ['package-lock.json', 'claude_project_code.txt', 'make_claude_doc.py']

def merge_project_files():
    project_dir = r"C:\schedule-app"
    output_file = os.path.join(project_dir, "claude_project_code.txt")
    
    with open(output_file, 'w', encoding='utf-8') as outfile:
        outfile.write("==================================================\n")
        outfile.write("★ [PROJECT SOURCE CODE SUMMARY FOR CLAUDE] ★\n")
        outfile.write("This file contains the complete source code of the app.\n")
        outfile.write("==================================================\n\n")
        
        for root, dirs, files in os.walk(project_dir):
            # 제외할 폴더 건너뛰기
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            
            for file in files:
                if file in EXCLUDE_FILES:
                    continue
                
                # 주요 텍스트 기반 코드 파일만 추출
                if file.endswith(('.html', '.js', '.css', '.py', '.json', '.txt', '.md')):
                    file_path = os.path.join(root, file)
                    rel_path = os.path.relpath(file_path, project_dir)
                    
                    try:
                        with open(file_path, 'r', encoding='utf-8') as infile:
                            content = infile.read()
                            
                        outfile.write(f"### FILE_PATH: {rel_path} ###\n")
                        outfile.write("```\n")
                        outfile.write(content)
                        outfile.write("\n```\n\n")
                        print(f"성공적으로 포함됨: {rel_path}")
                    except Exception as e:
                        print(f"읽기 실패 (건너뜀): {rel_path} - {e}")
                        
    print("\n🎉 완료! C:\\schedule-app\\claude_project_code.txt 파일이 생성되었습니다.")

if __name__ == "__main__":
    merge_project_files()