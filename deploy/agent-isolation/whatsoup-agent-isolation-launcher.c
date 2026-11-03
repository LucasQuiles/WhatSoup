/*
 * Linux-only, setuid-root launcher for WhatSoup provider workers.
 * Prototype only: kernel egress confinement and complete Linux qualification
 * are absent. Authority activation remains blocked; do not install for a pilot.
 *
 * This source is an installation artifact, not a runnable development helper.
 * Production installation must copy it outside every agent-writable tree,
 * compile it, set owner root:root and mode 04755, create a separate root-owned
 * 0600 policy, record both SHA-256 values, then configure the controller with
 * those installed paths. The TypeScript controller refuses any other shape
 * and accepts only its nonce-bound receipt emitted after this protected
 * launcher verifies the post-drop kernel identity. An unprivileged controller
 * cannot generally read the worker's /proc/<pid>/environ after the UID drop.
 */
#define _GNU_SOURCE

#ifndef __linux__
#error "whatsoup-agent-isolation-launcher is supported only on Linux"
#endif

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_POLICY_LINE 4096
#define MAX_PATHS 32
#define MAX_ENV 48
#define ISOLATED_PATH "/usr/bin:/bin"

struct policy {
  uid_t controller_uid;
  gid_t controller_gid;
  uid_t worker_uid;
  gid_t worker_gid;
  char home_dir[PATH_MAX];
  char config_home[PATH_MAX];
  char data_home[PATH_MAX];
  char *protected_paths[MAX_PATHS];
  size_t protected_path_count;
  char *allowed_binaries[MAX_PATHS];
  size_t allowed_binary_count;
  bool controller_uid_set;
  bool controller_gid_set;
  bool worker_uid_set;
  bool worker_gid_set;
};

extern char **environ;

static void fail(const char *message) {
  dprintf(STDERR_FILENO, "whatsoup-agent-isolation-launcher: %s\n", message);
  _exit(126);
}

static bool absolute_path(const char *value) {
  return value != NULL && value[0] == '/' && strstr(value, "\n") == NULL;
}

static bool parse_id(const char *value, unsigned long *out) {
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed > UINT_MAX) return false;
  *out = parsed;
  return true;
}

static void copy_path(char *destination, size_t destination_size, const char *value) {
  if (!absolute_path(value) || strlen(value) >= destination_size) fail("policy path is invalid");
  memcpy(destination, value, strlen(value) + 1);
}

static void append_path(char **items, size_t *count, const char *value) {
  if (!absolute_path(value) || *count >= MAX_PATHS) fail("policy path list is invalid");
  items[*count] = strdup(value);
  if (items[*count] == NULL) fail("memory allocation failed");
  *count += 1;
}

static void parse_policy_line(struct policy *policy, char *line) {
  char *newline = strchr(line, '\n');
  if (newline != NULL) *newline = '\0';
  if (line[0] == '\0' || line[0] == '#') return;
  char *separator = strchr(line, '=');
  if (separator == NULL || separator == line || separator[1] == '\0') fail("policy line is malformed");
  *separator = '\0';
  const char *key = line;
  const char *value = separator + 1;
  unsigned long id = 0;
  if (strcmp(key, "controller_uid") == 0) {
    if (policy->controller_uid_set || !parse_id(value, &id)) fail("controller_uid is invalid");
    policy->controller_uid = (uid_t) id;
    policy->controller_uid_set = true;
  } else if (strcmp(key, "controller_gid") == 0) {
    if (policy->controller_gid_set || !parse_id(value, &id)) fail("controller_gid is invalid");
    policy->controller_gid = (gid_t) id;
    policy->controller_gid_set = true;
  } else if (strcmp(key, "worker_uid") == 0) {
    if (policy->worker_uid_set || !parse_id(value, &id)) fail("worker_uid is invalid");
    policy->worker_uid = (uid_t) id;
    policy->worker_uid_set = true;
  } else if (strcmp(key, "worker_gid") == 0) {
    if (policy->worker_gid_set || !parse_id(value, &id)) fail("worker_gid is invalid");
    policy->worker_gid = (gid_t) id;
    policy->worker_gid_set = true;
  } else if (strcmp(key, "home_dir") == 0) {
    if (policy->home_dir[0] != '\0') fail("home_dir appears more than once");
    copy_path(policy->home_dir, sizeof(policy->home_dir), value);
  } else if (strcmp(key, "config_home") == 0) {
    if (policy->config_home[0] != '\0') fail("config_home appears more than once");
    copy_path(policy->config_home, sizeof(policy->config_home), value);
  } else if (strcmp(key, "data_home") == 0) {
    if (policy->data_home[0] != '\0') fail("data_home appears more than once");
    copy_path(policy->data_home, sizeof(policy->data_home), value);
  } else if (strcmp(key, "protected_path") == 0) {
    append_path(policy->protected_paths, &policy->protected_path_count, value);
  } else if (strcmp(key, "allowed_binary") == 0) {
    append_path(policy->allowed_binaries, &policy->allowed_binary_count, value);
  } else {
    fail("policy contains an unknown key");
  }
}

static void require_secure_parent_directories(const char *path, const char *label) {
  char parent[PATH_MAX];
  if (!absolute_path(path) || strlen(path) >= sizeof(parent)) fail("path for parent verification is invalid");
  memcpy(parent, path, strlen(path) + 1);
  char *slash = strrchr(parent, '/');
  if (slash == NULL) fail("path for parent verification is invalid");
  if (slash == parent) parent[1] = '\0';
  else *slash = '\0';
  while (true) {
    struct stat metadata;
    if (lstat(parent, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || S_ISLNK(metadata.st_mode)
        || metadata.st_uid != 0 || (metadata.st_mode & 0022) != 0) {
      fail(label);
    }
    if (strcmp(parent, "/") == 0) return;
    slash = strrchr(parent, '/');
    if (slash == parent) parent[1] = '\0';
    else *slash = '\0';
  }
}

static void read_policy(const char *path, struct policy *policy) {
  struct stat policy_metadata;
  if (!absolute_path(path) || lstat(path, &policy_metadata) != 0) fail("policy is unavailable");
  if (!S_ISREG(policy_metadata.st_mode) || policy_metadata.st_uid != 0 || (policy_metadata.st_mode & 0022) != 0) {
    fail("policy must be a root-owned non-writable regular file");
  }
  require_secure_parent_directories(path, "policy parent directories are not root-owned and non-writable");
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) fail("policy cannot be opened safely");
  struct stat opened_metadata;
  if (fstat(fd, &opened_metadata) != 0 || opened_metadata.st_dev != policy_metadata.st_dev || opened_metadata.st_ino != policy_metadata.st_ino) {
    close(fd);
    fail("policy changed while opening");
  }
  FILE *stream = fdopen(fd, "r");
  if (stream == NULL) {
    close(fd);
    fail("policy cannot be read");
  }
  char line[MAX_POLICY_LINE];
  while (fgets(line, sizeof(line), stream) != NULL) {
    if (strchr(line, '\n') == NULL && !feof(stream)) {
      fclose(stream);
      fail("policy line exceeds limit");
    }
    parse_policy_line(policy, line);
  }
  if (ferror(stream) != 0) {
    fclose(stream);
    fail("policy read failed");
  }
  fclose(stream);
  if (!policy->controller_uid_set || !policy->controller_gid_set || !policy->worker_uid_set || !policy->worker_gid_set
      || policy->controller_uid == 0 || policy->controller_gid == 0 || policy->worker_uid == 0 || policy->worker_gid == 0
      || policy->controller_uid == policy->worker_uid || policy->controller_gid == policy->worker_gid
      || policy->home_dir[0] == '\0' || policy->config_home[0] == '\0' || policy->data_home[0] == '\0'
      || policy->protected_path_count == 0 || policy->allowed_binary_count == 0) {
    fail("policy is incomplete");
  }
}

static bool command_is_allowed(const struct policy *policy, const char *command) {
  if (!absolute_path(command)) return false;
  for (size_t i = 0; i < policy->allowed_binary_count; i += 1) {
    if (strcmp(policy->allowed_binaries[i], command) == 0) return true;
  }
  return false;
}

static void require_private_worker_directory(const char *path, const struct policy *policy) {
  struct stat metadata;
  if (lstat(path, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_uid != policy->worker_uid
      || metadata.st_gid != policy->worker_gid || (metadata.st_mode & 0077) != 0) {
    fail("worker directory is not private to the isolated identity");
  }
}

static bool forbidden_environment_name(const char *name) {
  return strncmp(name, "LD_", 3) == 0 || strncmp(name, "DYLD_", 5) == 0
      || strncmp(name, "SUDO_", 5) == 0 || strncmp(name, "SSH_", 4) == 0
      || strncmp(name, "GIT_", 4) == 0
      || strncmp(name, "CHROME_", 7) == 0 || strncmp(name, "PLAYWRIGHT_", 11) == 0
      || strncmp(name, "PUPPETEER_", 10) == 0 || strncmp(name, "BROWSER_", 8) == 0
      || strncmp(name, "CHROMIUM_", 9) == 0 || strncmp(name, "FIREFOX_", 8) == 0
      || strncmp(name, "CDP_", 4) == 0 || strcmp(name, "NODE_OPTIONS") == 0
      || strcmp(name, "NODE_PATH") == 0 || strcmp(name, "BASH_ENV") == 0
      || strcmp(name, "ENV") == 0 || strcmp(name, "WHATSOUP_HEALTH_TOKEN") == 0
      || strcmp(name, "AUTHORIZATION") == 0;
}

static const char *safe_environment_names[MAX_ENV] = {
  "LANG", "TERM",
  "WHATSOUP_INSTANCE", "WHATSOUP_MCP_SOCKET", "WHATSOUP_MCP_SESSION_TOKEN",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "MINIMAX_API_KEY",
  "KIMI_API_KEY", "ZAI_API_KEY", "XAI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY", NULL,
};

static bool reset_environment_name(const char *name) {
  return strcmp(name, "PATH") == 0 || strcmp(name, "HOME") == 0
      || strcmp(name, "USER") == 0 || strcmp(name, "SHELL") == 0
      || strcmp(name, "XDG_RUNTIME_DIR") == 0 || strcmp(name, "XDG_CONFIG_HOME") == 0
      || strcmp(name, "XDG_DATA_HOME") == 0 || strcmp(name, "TMPDIR") == 0;
}

static bool safe_environment_name(const char *name) {
  for (size_t i = 0; safe_environment_names[i] != NULL; i += 1) {
    if (strcmp(name, safe_environment_names[i]) == 0) return true;
  }
  return false;
}

static void validate_inherited_environment(void) {
  for (char **entry = environ; entry != NULL && *entry != NULL; entry += 1) {
    char *separator = strchr(*entry, '=');
    if (separator == NULL) fail("environment is malformed");
    size_t length = (size_t) (separator - *entry);
    if (length == 0 || length >= 256) fail("environment variable name is invalid");
    char name[256];
    memcpy(name, *entry, length);
    name[length] = '\0';
    if (forbidden_environment_name(name)) fail("environment contains a forbidden inherited capability");
    if (!safe_environment_name(name) && !reset_environment_name(name)) {
      fail("environment contains a non-allowlisted inherited capability");
    }
  }
}

static bool checked_loopback_proxy(const char *value) {
  if (value == NULL || strncmp(value, "http://127.0.0.1:", 17) != 0) return false;
  char *end = NULL;
  errno = 0;
  const long port = strtol(value + 17, &end, 10);
  return errno == 0 && end != value + 17 && *end == '\0' && port > 0 && port <= 65535;
}

static void validate_proxy_environment(void) {
  const char *upper_http = getenv("HTTP_PROXY");
  const char *upper_https = getenv("HTTPS_PROXY");
  const char *lower_http = getenv("http_proxy");
  const char *lower_https = getenv("https_proxy");
  const char *no_proxy = getenv("NO_PROXY");
  const char *no_proxy_lower = getenv("no_proxy");
  if (upper_http == NULL && upper_https == NULL && lower_http == NULL && lower_https == NULL) {
    if (no_proxy != NULL || no_proxy_lower != NULL) fail("proxy bypass configuration is incomplete");
    return;
  }
  if (!checked_loopback_proxy(upper_http) || !checked_loopback_proxy(upper_https)
      || !checked_loopback_proxy(lower_http) || !checked_loopback_proxy(lower_https)
      || strcmp(upper_http, upper_https) != 0
      || strcmp(upper_http, lower_http) != 0 || strcmp(upper_http, lower_https) != 0
      || no_proxy == NULL || no_proxy_lower == NULL
      || strcmp(no_proxy, "localhost,127.0.0.1") != 0 || strcmp(no_proxy_lower, "localhost,127.0.0.1") != 0) {
    fail("proxy must use the checked loopback egress route");
  }
}

static void rebuild_environment(const struct policy *policy) {
  char *values[MAX_ENV] = {0};
  for (size_t i = 0; safe_environment_names[i] != NULL; i += 1) {
    const char *inherited_value = getenv(safe_environment_names[i]);
    if (inherited_value != NULL) {
      values[i] = strdup(inherited_value);
      if (values[i] == NULL) fail("environment copy allocation failed");
    }
  }
  const char *socket = getenv("WHATSOUP_MCP_SOCKET");
  const char *token = getenv("WHATSOUP_MCP_SESSION_TOKEN");
  if ((socket == NULL) != (token == NULL) || (socket != NULL && !absolute_path(socket))) {
    fail("MCP session token is not bound to a checked Unix socket");
  }
  validate_proxy_environment();
  if (clearenv() != 0) fail("environment clearing failed");
  for (size_t i = 0; safe_environment_names[i] != NULL; i += 1) {
    if (values[i] != NULL && setenv(safe_environment_names[i], values[i], 1) != 0) fail("safe environment reconstruction failed");
    free(values[i]);
  }
  if (setenv("HOME", policy->home_dir, 1) != 0 || setenv("XDG_CONFIG_HOME", policy->config_home, 1) != 0
      || setenv("XDG_DATA_HOME", policy->data_home, 1) != 0 || setenv("PATH", ISOLATED_PATH, 1) != 0) {
    fail("isolated home environment setup failed");
  }
}

static void prove_protected_paths_denied(const struct policy *policy) {
  for (size_t i = 0; i < policy->protected_path_count; i += 1) {
    const int modes[] = {R_OK, W_OK, X_OK};
    for (size_t mode = 0; mode < sizeof(modes) / sizeof(modes[0]); mode += 1) {
      errno = 0;
      if (faccessat(AT_FDCWD, policy->protected_paths[i], modes[mode], 0) == 0 || (errno != EACCES && errno != EPERM)) {
        fail("worker can access a protected path");
      }
    }
  }
}

static void require_protected_parent_directories(const char *path, const struct policy *policy) {
  char parent[PATH_MAX];
  if (!absolute_path(path) || strlen(path) >= sizeof(parent)) fail("protected path for parent verification is invalid");
  memcpy(parent, path, strlen(path) + 1);
  char *slash = strrchr(parent, '/');
  if (slash == NULL) fail("protected path for parent verification is invalid");
  if (slash == parent) parent[1] = '\0';
  else *slash = '\0';
  while (true) {
    struct stat metadata;
    if (lstat(parent, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || S_ISLNK(metadata.st_mode)
        || metadata.st_uid == policy->worker_uid || (metadata.st_mode & 0022) != 0) {
      fail("protected path parent is writable by or owned by the worker");
    }
    if (strcmp(parent, "/") == 0) return;
    slash = strrchr(parent, '/');
    if (slash == parent) parent[1] = '\0';
    else *slash = '\0';
  }
}

static void prove_controller_signal_denied(pid_t controller_pid) {
  errno = 0;
  if (kill(controller_pid, 0) == 0 || errno != EPERM) {
    fail("worker can signal the controller host process");
  }
}

static void prove_other_process_environment_denied(void) {
  errno = 0;
  int fd = open("/proc/1/environ", O_RDONLY | O_CLOEXEC);
  if (fd >= 0) {
    close(fd);
    fail("worker can read another process environment");
  }
  if (errno != EACCES && errno != EPERM) fail("other-process protection is not provable");
}

static void write_receipt(int receipt_fd, const char *nonce, const struct policy *policy) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  gid_t groups[2] = {0};
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 || getresgid(&real_gid, &effective_gid, &saved_gid) != 0
      || real_uid != policy->worker_uid || effective_uid != policy->worker_uid || saved_uid != policy->worker_uid
      || real_gid != policy->worker_gid || effective_gid != policy->worker_gid || saved_gid != policy->worker_gid
      || getgroups(2, groups) != 1 || groups[0] != policy->worker_gid) {
    fail("post-drop kernel identity verification failed");
  }
  if (dprintf(receipt_fd, "{\"version\":1,\"state\":\"isolated\",\"pid\":%ld,\"nonce\":\"%s\",\"uid\":%u,\"gid\":%u,\"groups\":[%u]}\n",
      (long) getpid(), nonce, (unsigned) real_uid, (unsigned) real_gid, (unsigned) groups[0]) < 0) {
    fail("receipt write failed");
  }
  if (fcntl(receipt_fd, F_SETFD, FD_CLOEXEC) != 0) fail("receipt fd close-on-exec failed");
}

int main(int argc, char **argv) {
  if (argc < 9 || strcmp(argv[1], "--policy") != 0 || strcmp(argv[3], "--receipt-fd") != 0
      || strcmp(argv[5], "--nonce") != 0 || strcmp(argv[7], "--") != 0) {
    fail("usage is --policy <absolute-path> --receipt-fd <fd> --nonce <hex> -- <provider> [args...]");
  }
  char *end = NULL;
  errno = 0;
  long parsed_fd = strtol(argv[4], &end, 10);
  if (errno != 0 || end == argv[4] || *end != '\0' || parsed_fd < 3 || parsed_fd > INT_MAX) fail("receipt fd is invalid");
  const int receipt_fd = (int) parsed_fd;
  const char *nonce = argv[6];
  if (strlen(nonce) != 64) fail("controller nonce is malformed");
  for (size_t i = 0; i < 64; i += 1) {
    if ((nonce[i] < '0' || nonce[i] > '9') && (nonce[i] < 'a' || nonce[i] > 'f')) fail("controller nonce is malformed");
  }
  const int command_index = 8;
  const pid_t controller_pid = getppid();
  struct policy policy = {0};
  read_policy(argv[2], &policy);
  if (getuid() != policy.controller_uid || getgid() != policy.controller_gid) fail("caller is not the configured controller identity");
  if (!command_is_allowed(&policy, argv[command_index])) fail("provider binary is not allowed by policy");
  validate_inherited_environment();
  rebuild_environment(&policy);
  require_private_worker_directory(policy.home_dir, &policy);
  require_private_worker_directory(policy.config_home, &policy);
  require_private_worker_directory(policy.data_home, &policy);
  for (size_t i = 0; i < policy.protected_path_count; i += 1) {
    require_protected_parent_directories(policy.protected_paths[i], &policy);
  }
  gid_t groups[] = {policy.worker_gid};
  if (setgroups(1, groups) != 0) fail("supplementary group drop failed");
  if (setresgid(policy.worker_gid, policy.worker_gid, policy.worker_gid) != 0) fail("worker gid switch failed");
  if (setresuid(policy.worker_uid, policy.worker_uid, policy.worker_uid) != 0) fail("worker uid switch failed");
  prove_protected_paths_denied(&policy);
  prove_controller_signal_denied(controller_pid);
  prove_other_process_environment_denied();
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) {
    fail("no-new-privileges proof failed");
  }
  write_receipt(receipt_fd, nonce, &policy);
  execve(argv[command_index], &argv[command_index], environ);
  fail("provider exec failed");
}
