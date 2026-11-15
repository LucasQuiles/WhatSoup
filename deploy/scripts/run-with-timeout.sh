#!/usr/bin/env bash
# Run one command with a portable hard deadline. Arguments are never flattened
# into a command string, so spaces and shell metacharacters remain data.
set -u

if [[ $# -lt 2 || ! "$1" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: run-with-timeout.sh <positive-seconds> <command> [args...]" >&2
  exit 64
fi

seconds="$1"
shift

# GNU timeout is not used: with --signal=KILL it signals its own process
# group, so it dies with status 137 instead of reporting the deadline as 124.
exec /usr/bin/perl -MPOSIX=:sys_wait_h,setpgid -e '
  my $seconds = shift @ARGV;
  my $pid = fork();
  exit 125 unless defined $pid;
  if ($pid == 0) {
    setpgid(0, 0);
    exec @ARGV;
    exit 127;
  }
  setpgid($pid, $pid);
  $SIG{ALRM} = sub {
    kill "KILL", -$pid;
    waitpid($pid, 0);
    exit 124;
  };
  alarm $seconds;
  waitpid($pid, 0);
  alarm 0;
  my $status = $?;
  exit WEXITSTATUS($status) if WIFEXITED($status);
  exit 128 + WTERMSIG($status) if WIFSIGNALED($status);
  exit 125;
' "$seconds" "$@"
