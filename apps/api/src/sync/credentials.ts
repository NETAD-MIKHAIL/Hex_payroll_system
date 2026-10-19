import { spawn } from 'node:child_process';
import { z } from 'zod';

export interface CredentialProvider {
  read(nodeId: string): Promise<string>;
  write(nodeId: string, token: string): Promise<void>;
  remove(nodeId: string): Promise<void>;
}
// Fixed native code, supplied on stdin. Secrets never appear in arguments,
// environment, files, PowerShell history, or error output.
const native = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public class HexCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct C {
 public uint Flags; public uint Type; public string TargetName; public string Comment;
 public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
 public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
 public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
 }
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredWriteW(ref C c,uint flags);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredReadW(string target,uint type,uint flags,out IntPtr p);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredDeleteW(string target,uint type,uint flags);
 public static void Delete(string target){if(!CredDeleteW(target,1,0))throw new Exception("Credential deletion failed");}
 public static void Write(string target,string token){
 var bytes=Encoding.Unicode.GetBytes(token); var p=Marshal.AllocHGlobal(bytes.Length);
 try {Marshal.Copy(bytes,0,p,bytes.Length);var c=new C {Type=1,TargetName=target,UserName="HexPayroll",CredentialBlob=p,CredentialBlobSize=(uint)bytes.Length,Persist=2};if(!CredWriteW(ref c,0))throw new Exception("Credential store unavailable");}
 finally {for(int i=0;i<bytes.Length;i++)Marshal.WriteByte(p,i,0);Marshal.FreeHGlobal(p);}
 }
 public static string Read(string target){IntPtr p;if(!CredReadW(target,1,0,out p))throw new Exception("Credential unavailable");try {var c=(C)Marshal.PtrToStructure(p,typeof(C));return Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2);}finally {CredFree(p);}}
}
`;
async function invoke(operation: 'read' | 'write' | 'delete', nodeId: string, token?: string) {
  z.uuid().parse(nodeId);
  if (process.platform !== 'win32') throw new Error('Windows Credential Manager is required');
  const target = 'HexPayroll/Sync/' + nodeId;
  // Only validated UUIDs and base64url tokens are embedded in this stdin script.
  if (token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('Invalid credential');
  const script = `$ErrorActionPreference='Stop'\ntry {\nAdd-Type -TypeDefinition @'\n${native}\n'@\n${operation === 'read' ? `[HexCredential]::Read('${target}')` : operation === 'delete' ? `[HexCredential]::Delete('${target}')` : `[HexCredential]::Write('${target}','${token}')`}\n} catch { exit 1 }\n`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$script = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($script))',
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.length > 4096) child.kill();
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Credential store unavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Credential store unavailable'));
      else resolve(output.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}
export const windowsCredentials: CredentialProvider = {
  async read(id) {
    const token = await invoke('read', id);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Credential unavailable');
    return token;
  },
  async write(id, token) {
    await invoke('write', id, token);
  },
  async remove(id) {
    await invoke('delete', id);
  },
};
