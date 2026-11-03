/* Exercise the actual policy reader without executing the privileged launcher. */
#define main isolation_launcher_main
#include "../../../deploy/agent-isolation/whatsoup-agent-isolation-launcher.c"
#undef main

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  struct policy policy = {0};
  read_policy(argv[1], &policy);
  printf("%u\n", (unsigned) policy.controller_gid);
  return 0;
}
