#!/bin/bash
set -e
docker-compose stop eform
docker-compose rm -f eform
docker-compose build eform
docker-compose up -d eform

echo "Update gotowy"