#!/bin/zsh
# usage: ./shot.sh page.html out.png height
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1440,${3:-1600} --virtual-time-budget=4000 --screenshot="$PWD/$2" "file://$PWD/$1" 2>/dev/null
