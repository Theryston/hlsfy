#!/bin/sh
if [ ! -d "db" ]; then
  mkdir db
fi

bun run start
