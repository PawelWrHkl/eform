#!/bin/bash
cd /home/pawel/projects/eform

git add .
git commit -m "Automatic commit $(date '+%Y-%m-%d %H:%M')"
git push origin main