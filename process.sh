#!/bin/bash

if [ -z "${1}" ] || [ -z "${2}" ] || [ "${1}" == "-h|--help" ]
then
  echo "Usage:"
  echo "  process.sh /path/to/calibre.recipe Title"
  exit 0
fi

RECIPE_PATH="$1"
TITLE="${@:2}"
DATE=`date +%Y-%m-%d`

FETCHED_DIR_PATH="${HOME}/calibre-fetched"
if [ ! -d ${FETCHED_DIR_PATH} ]
then
  mkdir ${FETCHED_DIR_PATH}
fi

ebook-convert "${RECIPE_PATH}" "${FETCHED_DIR_PATH}/Pinboard-${DATE}-${TITLE}.epub" \
  --change-justification left \
  --title "${TITLE} ${DATE}" --output-profile generic_eink_hd

rclone --max-depth 1 -P -v copy /home/lypanov/calibre-fetched/ "koofr:Boox Sync"
