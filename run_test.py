#!/usr/bin/env python3
"""Run buildingTest on remote server via paramiko"""
import paramiko

HOST = '211.188.63.15'
USER = 'root'
PASSWORD = 'M3!A-FiFh9Pg'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD)

cmd = 'cd /opt/slack-realestate-bot && node dist/test/buildingTest.js 2>&1'
print(f'Running: {cmd}\n')

stdin, stdout, stderr = ssh.exec_command(cmd, timeout=300)
for line in stdout:
    print(line, end='')
err = stderr.read().decode()
if err:
    print('STDERR:', err)

ssh.close()
