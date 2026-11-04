/* Exercise the actual policy reader without executing the privileged launcher. */
#define main isolation_launcher_main
#include "../../../deploy/agent-isolation/whatsoup-agent-isolation-launcher.c"
#undef main

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--binary") == 0) {
    require_secure_provider_binary(argv[2]);
    return 0;
  }
  if (argc != 2) return 2;
  struct policy policy = {0};
  read_policy(argv[1], &policy);
  printf("%u\n", (unsigned) policy.controller_gid);
  return 0;
}
