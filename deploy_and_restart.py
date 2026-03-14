#!/usr/bin/env python3
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('211.188.63.15', username='root', password='M3!A-FiFh9Pg', look_for_keys=False, allow_agent=False)

sftp = ssh.open_sftp()
files = [
    'handlers/commandHandler.js',
    'services/tilkoApiService.js',
    'services/tilkoBuildingService.js',
    'services/unifiedBuildingService.js',
    'services/geminiService.js',
]
for f in files:
    print(f'  Uploading: {f}')
    sftp.put(f'dist/{f}', f'/opt/slack-realestate-bot/dist/{f}')
sftp.close()

stdin, stdout, stderr = ssh.exec_command('cd /opt/slack-realestate-bot && pm2 restart ledgerbot')
print(stdout.read().decode())
ssh.close()
print('Deploy complete!')
