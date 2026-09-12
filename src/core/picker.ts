import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync=promisify(execFile);
export async function pickProjectFolder():Promise<string>{
  if(process.platform==="win32"){
    const script='Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description="Choose a project folder"; if($d.ShowDialog() -eq "OK"){Write-Output $d.SelectedPath}';
    const{stdout}=await execFileAsync("powershell.exe",["-NoProfile","-STA","-Command",script],{windowsHide:true});return stdout.trim();
  }
  if(process.platform==="darwin"){
    const{stdout}=await execFileAsync("osascript",["-e",'POSIX path of (choose folder with prompt "Choose a project folder")']);return stdout.trim().replace(/\/$/,"");
  }
  try{const{stdout}=await execFileAsync("zenity",["--file-selection","--directory","--title=Choose a project folder"]);return stdout.trim()}catch{throw new Error("Folder picker is unavailable on this Linux desktop. Enter the path manually.")}
}
