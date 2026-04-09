{% if system == 'Windows' %}
## Platform Policy (Windows)
- You are running on Windows. Do not assume GNU tools exist.
- Prefer file tools and safe built-in operations.
{% else %}
## Platform Policy (POSIX)
- You are running on a POSIX system. Prefer UTF-8 and standard shell tools when available.
{% endif %}
