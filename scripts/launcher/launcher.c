#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t child = 0;

static void forward(int sig) {
  if (child > 0) kill(child, sig);
}

// Started by launchd in place of Node, this process stays macOS's responsible process for everything the service
// runs, so the Automation permission is granted to it. Exec'ing Node would make Node responsible again, and Node's
// hardened runtime lacks the Apple Events entitlement, so it can never be granted.
int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s program [argument ...]\n", argv[0]);
    return 64;
  }
  static const int forwarded[] = { SIGTERM, SIGINT, SIGHUP };
  sigset_t block, none;
  sigemptyset(&block);
  sigemptyset(&none);
  for (size_t i = 0; i < sizeof forwarded / sizeof *forwarded; i++) sigaddset(&block, forwarded[i]);
  // Held until the child's pid is known, so a stop that arrives during the spawn still reaches it.
  sigprocmask(SIG_BLOCK, &block, NULL);
  struct sigaction sa = { .sa_handler = forward };
  sigemptyset(&sa.sa_mask);
  for (size_t i = 0; i < sizeof forwarded / sizeof *forwarded; i++) sigaction(forwarded[i], &sa, NULL);

  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setsigmask(&attr, &none);
  posix_spawnattr_setsigdefault(&attr, &block);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  pid_t pid;
  int err = posix_spawn(&pid, argv[1], NULL, &attr, argv + 1, environ);
  posix_spawnattr_destroy(&attr);
  if (err) {
    fprintf(stderr, "pitwall launcher: cannot start %s: %s\n", argv[1], strerror(err));
    return 127;
  }
  child = pid;
  sigprocmask(SIG_UNBLOCK, &block, NULL);

  int status;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) {
      perror("pitwall launcher: waitpid");
      return 1;
    }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  // Dying of the same signal tells launchd what the child's death would have.
  int sig = WTERMSIG(status);
  signal(sig, SIG_DFL);
  sigset_t only;
  sigemptyset(&only);
  sigaddset(&only, sig);
  sigprocmask(SIG_UNBLOCK, &only, NULL);
  raise(sig);
  return 128 + sig;
}
