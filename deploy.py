#!/usr/bin/env python3
"""Paramiko-based deploy script for ledgerbot"""
import paramiko
import os
import sys

HOST = '211.188.63.15'
USER = 'root'
PASSWORD = 'M3!A-FiFh9Pg'
REMOTE_BASE = '/opt/slack-realestate-bot'
LOCAL_BASE = os.path.join(os.path.dirname(__file__), 'dist')

# Files to deploy
FILES = [
    'handlers/commandHandler.js',
    'services/tilkoBuildingService.js',
    'services/unifiedBuildingService.js',
    'services/geminiService.js',
    'test/buildingTest.js',
]

def main():
    print(f'Connecting to {HOST}...')
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASSWORD)
    print('Connected!')

    sftp = ssh.open_sftp()

    for f in FILES:
        local = os.path.join(LOCAL_BASE, f)
        remote = f'{REMOTE_BASE}/dist/{f}'
        if not os.path.exists(local):
            print(f'  SKIP (not found): {local}')
            continue
        print(f'  Uploading: {f}')
        sftp.put(local, remote)

    sftp.close()
    print('\nAll files uploaded. Restarting PM2...')

    stdin, stdout, stderr = ssh.exec_command('cd /opt/slack-realestate-bot && pm2 restart ledgerbot')
    print(stdout.read().decode())
    err = stderr.read().decode()
    if err:
        print('STDERR:', err)

    ssh.close()
    print('Deploy complete!')

if __name__ == '__main__':
    main()
