#!/bin/sh
set -e

input_mode() {
  printf "Input environment, p (= production) || d (= development) || l (= local): "
  read -r ans
  process_input_mode "$ans"
}

input_force_restart() {
  printf "Force restart all? (y/N): "
  read -r ans
  set_force_restart "${ans:-n}"
}

process_input_mode() {
  case "$1" in
  p)
    set_mode "production"
    ;;
  d)
    set_mode "dev"
    ;;
  l)
    set_mode "local"
    ;;
  *)
    echo "Invalid input. Please enter 'p', 'd', or 'l'."
    exit 1
    ;;
  esac
}

set_mode() {
  MODE="$1"
}

set_force_restart() {
  FORCE_RESTART="$1"
}

show_help() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  -m, --mode MODE           Set the mode (production, dev, local).
  -f, --force-restart       Force restart all processes.
      --help                Display this help and exit.

Examples:
  $(basename "$0") -m production
  $(basename "$0") --mode=dev --force-restart
EOF
}

run_interactive() {
  input_mode
}

OPTIONS_SET=false

while [ $# -gt 0 ]; do
  case "$1" in
  -m | --mode)
    OPTIONS_SET=true
    if [ -n "$2" ]; then
      set_mode "$2"
      shift
    else
      echo "Option '$1' requires an argument."
      exit 1
    fi
    ;;
  --mode=*)
    OPTIONS_SET=true
    set_mode "${1#*=}"
    ;;
  -f | --force-restart)
    OPTIONS_SET=true
    set_force_restart "y"
    ;;
  --help)
    show_help
    exit 0
    ;;
  -*)
    echo "$(basename "$0"): unrecognized option '$1'."
    echo "Try '$(basename "$0") --help' for more information."
    exit 1
    ;;
  *)
    # If other arguments are required, they are handled here.
    ;;
  esac
  shift
done

if [ "$OPTIONS_SET" = false ]; then
  run_interactive
fi

if [ -z "$MODE" ]; then
  echo "$(basename "$0"): '-m' or '--mode' option is required."
  echo "Try '$(basename "$0") --help' for more information."
  exit 1
fi

if [ "$OPTIONS_SET" = true ] && [ -z "$FORCE_RESTART" ]; then
  FORCE_RESTART="n"
fi

# From here, write your application script below.

APP_NAME="socketing-queue-server"

cd "$(dirname "$0")" || exit

if ! command -v npm >/dev/null 2>&1; then
  echo "Cannot run script: npm not installed."
  exit 1
fi

npm i

if ! command -v pm2 >/dev/null 2>&1; then
  npm i pm2 -g
fi

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  if [ -z "$FORCE_RESTART" ]; then
    input_force_restart
  fi
  if [ "$FORCE_RESTART" = "y" ]; then
    echo "Force restarting..."
    pm2 delete $APP_NAME
    pm2 start ecosystem.json --only $APP_NAME --env "$MODE"
  else
    echo "'$APP_NAME' is already running, reloading..."
    pm2 reload ecosystem.json --only $APP_NAME --env "$MODE"
  fi
else
  echo "Starting for the first time..."
  pm2 start ecosystem.json --only $APP_NAME --env "$MODE"
fi

pm2 reset $APP_NAME

echo "Successfully done."
