Set WshShell = CreateObject("WScript.Shell")
Set Shortcut = WshShell.CreateShortcut(WshShell.SpecialFolders("Desktop") & "\FRIDAY AI.lnk")
Shortcut.TargetPath = "d:\ABeezzz LABS\FRIDAY_AI_v1\launch-friday.bat"
Shortcut.WorkingDirectory = "d:\ABeezzz LABS\FRIDAY_AI_v1"
Shortcut.Description = "Launch FRIDAY AI"
Shortcut.WindowStyle = 7
Shortcut.Save
WScript.Echo "Shortcut created on Desktop!"
