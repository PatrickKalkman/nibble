#!/bin/bash

# deploy.sh - Automated deployment script
set -e  # Exit on error

LOG_FILE="/home/ubuntu/nibble/logs/deploy.log"
APP_DIR="/home/ubuntu/nibble"

echo "$(date): Starting deployment" >> $LOG_FILE

cd $APP_DIR

# Pull latest changes
echo "$(date): Pulling latest changes" >> $LOG_FILE
git pull origin master >> $LOG_FILE 2>&1

# Install/update dependencies
echo "$(date): Installing dependencies" >> $LOG_FILE
npm install >> $LOG_FILE 2>&1

# Restart the application
echo "$(date): Restarting application" >> $LOG_FILE
pm2 restart nibble >> $LOG_FILE 2>&1

echo "$(date): Deployment complete" >> $LOG_FILE

# Keep last 1000 lines of log
tail -n 1000 $LOG_FILE > $LOG_FILE.tmp && mv $LOG_FILE.tmp $LOG_FILE