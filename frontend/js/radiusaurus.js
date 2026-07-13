const API = "/api";
let token = localStorage.getItem("radiusaurus_token");
let cachedUsers = [];
let cachedMacs = [];
let cachedGroups = [];
let cachedVlans = [];
let cachedClients = [];
let currentPage = "status";
let viewingLogDetails = false;
let selectedConfigFileKey = null;

function showLogin() {
  document.getElementById("loginView").style.display = "flex";
  document.getElementById("appView").style.display = "none";
}

function showApp() {
  document.getElementById("loginView").style.display = "none";
  document.getElementById("appView").style.display = "block";
}

const PAGE_FILES = {
  status: "status.html",
  users: "users.html",
  macs: "macs.html",
  certificates: "certificates.html",
  groups: "groups.html",
  vlans: "vlans.html",
  clients: "clients.html",
  policies: "policies.html",
  logs: "logs.html",
  settings: "settings.html"
};

async function showPage(page) {
  currentPage = page;

  document.querySelectorAll(".nav button").forEach(button => {
    button.classList.remove("active");
  });

  const navMap = {
    status: "navStatus",
    users: "navUsers",
    macs: "navMacs",
    certificates: "navCertificates",
    groups: "navGroups",
    vlans: "navVlans",
    clients: "navClients",
    policies: "navPolicies",
    logs: "navLogs",
    settings: "navSettings"
  };

  const titleMap = {
    status: "Status",
    users: "Users",
    macs: "MAC-addresses",
    certificates: "Certificates",
    groups: "Groups",
    vlans: "VLANs",
    clients: "RADIUS Clients",
    policies: "Policies",
    logs: "Logs",
    settings: "Settings"
  };

  document.getElementById(navMap[page])?.classList.add("active");
  document.getElementById("pageTitle").textContent = titleMap[page];

  const appContent = document.getElementById("appContent");
  appContent.innerHTML = "<div class='panel'>Loading...</div>";

  const response = await fetch("/pages/" + PAGE_FILES[page]);

  if (!response.ok) {
    appContent.innerHTML =
      "<div class='panel'><pre>Could not load /pages/" +
      PAGE_FILES[page] +
      "</pre></div>";
    return;
  }

  appContent.innerHTML = await response.text();

  if (page === "status") {  loadStatus();}
  if (page === "users") loadUsers();
  if (page === "macs") loadMacPageData();
  if (page === "certificates") { loadCertificateDropdowns(); loadCertificates();  }
  if (page === "groups") loadGroups();
  if (page === "vlans") loadVlans();
  if (page === "clients") loadClients(); loadClientSetupSettings();
  if (page === "policies") loadPolicies();
  if (page === "logs") loadLogs();
  if (page === "settings") {  loadSettings(); loadConfigFiles(); }
}

async function login(username, password) {
  const body = new URLSearchParams();
  body.append("username", username);
  body.append("password", password);

  const response = await fetch(API + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(text || "Invalid username or password");
  }

  const data = JSON.parse(text);
  token = data.access_token;
  localStorage.setItem("radiusaurus_token", token);

  showApp();
  showPage("status");
}

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  if (response.status === 401) {
    logout();
    throw new Error("Session expired. Please login again.");
  }

  if (!response.ok) {
    throw new Error(text || "API error");
  }

  return text ? JSON.parse(text) : {};
}

function showOutput(data) {
  const output = document.getElementById("output");

  if (typeof data === "string") {
    output.innerHTML = `<pre>${escapeHtml(data)}</pre>`;
    return;
  }

  const users = [...new Set(data.map(row => row.username))].filter(Boolean);

  if (!users.length) {
    output.innerHTML = "<p class='muted'>No users found.</p>";
    return;
  }

  output.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Group</th>
            <th>Linked MAC addresses</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(username => {
            const userGroupRow = data.find(row => row.username === username && row.groupname);
            const groupName = userGroupRow?.groupname || "-";

            const linkedMacs = cachedMacs
              .filter(mac => mac.username === username)
              .map(mac => `${formatMac(mac.mac)} (${escapeHtml(mac.device_name || "Unnamed device")})`);

            return `
              <tr>
                <td><strong>${escapeHtml(username)}</strong></td>
                <td>${escapeHtml(groupName)}</td>
                <td>${linkedMacs.length ? linkedMacs.join("<br>") : "<span class='muted'>No linked MACs</span>"}</td>
                <td>
                  <button class="small-btn" onclick="editUser('${escapeJs(username)}', '${escapeJs(groupName)}')">Edit</button>
                  <button class="delete-btn" onclick="deleteUser('${escapeJs(username)}')">Delete</button>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}
//Status
async function loadStatus() {
  try {
    const status = await api("/status/all");

    document.getElementById("statusOutput").innerHTML = `
      <div class="table-wrap">
        <table>
          <tbody>
            <tr><th>FreeRADIUS</th><td>${status.freeradius_active ? "✅ Active" : "❌ " + escapeHtml(status.freeradius_status)}</td></tr>
            <tr><th>Config test</th><td>${status.config_ok ? "✅ OK" : "❌ Failed"}</td></tr>
            <tr><th>Database</th><td>${status.database_ok ? "✅ OK" : "❌ Failed"}</td></tr>
          </tbody>
        </table>
      </div>
    `;

    document.getElementById("failedAuthOutput").innerHTML =
      renderAuthStatusTable(status.recent_failed_auth);

    document.getElementById("recentAuthOutput").innerHTML =
      renderAuthStatusTable(status.recent_auth);

  } catch (err) {
    document.getElementById("statusOutput").innerHTML =
      `<pre>ERROR loading status:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

function renderAuthStatusTable(rows) {
  if (!rows || !rows.length) {
    return "<p class='muted'>No records found.</p>";
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User / MAC</th>
            <th>Result</th>
            <th>NAS IP</th>
            <th>Device MAC</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td>${escapeHtml(formatLocalTime(row.created_at))}</td>
              <td><strong>${escapeHtml(row.username || "-")}</strong></td>
              <td>${escapeHtml(row.reply_packet_type || "-")}</td>
              <td>${escapeHtml(row.nas_ip_address || "-")}</td>
              <td>${escapeHtml(row.calling_station_id || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// Certificates
async function loadCertificates() {
  const output = document.getElementById("certificatesOutput");

  try {
    const certs = await api("/certificates");

    if (!certs.length) {
      output.innerHTML = "<p class='muted'>No client certificates found.</p>";
      return;
    }

    output.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>User</th>
              <th>MAC</th>  
              <th>Device</th>
              <th>PFX</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${certs.map(cert => `
              <tr>
                <td><strong>${escapeHtml(cert.name)}</strong></td>
                <td>${escapeHtml(cert.username || "-")}</td>
                <td>${cert.mac ? escapeHtml(formatMac(cert.mac)) : "-"}</td>
                <td>${escapeHtml(cert.device_name || "-")}</td>
                <td>${cert.has_pfx ? "Available" : "Missing"}</td>
                <td>
                  ${cert.revoked
                    ? "<span style='color:#dc2626;font-weight:700'>Revoked</span>"
                    : "<span style='color:#15803d;font-weight:700'>Active</span>"
                  }
                </td>
                <td>
                  <button class="small-btn" onclick="downloadClientCertificate('${escapeJs(cert.name)}')">
                    Download PFX
                  </button>

                  ${cert.revoked
                    ? `<button class="small-btn" style="background:#94a3b8" disabled>Revoked</button>`
                    : `<button class="small-btn" style="background:#f59e0b" onclick="revokeClientCertificate('${escapeJs(cert.name)}')">Revoke</button>`
                  }

                  <button class="delete-btn" onclick="deleteClientCertificate('${escapeJs(cert.name)}')">
                    Delete
                  </button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    output.innerHTML = `<pre>ERROR loading certificates:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

async function createClientCertificate() {
  const status = document.getElementById("certStatus");

  const commonName = document.getElementById("certCommonName").value;
  const exportPassword = document.getElementById("certExportPassword").value;
  const days = Number(document.getElementById("certValidDays").value || 365);

  if (!commonName || !exportPassword) {
    status.textContent = "Certificate name and export password are required.";
    return;
  }

  try {
    status.textContent = "Creating certificate...";

    const result = await api("/certificates/client", {
      method: "POST",
      body: JSON.stringify({
        common_name: commonName,
        export_password: exportPassword,
        days: days,
        username: document.getElementById("certUsername").value || null,
        mac: document.getElementById("certMac").value || null,
        device_name: document.getElementById("certDeviceName").value || null,
        description: document.getElementById("certDescription").value || null
      })
    });

    status.textContent = "Created certificate: " + result.name;

    document.getElementById("certCommonName").value = "";
    document.getElementById("certExportPassword").value = "";

    await loadCertificates();
  } catch (err) {
    status.textContent = "ERROR creating certificate:\n\n" + err.message;
  }
}

async function downloadAuthenticatedFile(path, filename) {
  const response = await fetch(API + path, {
    headers: {
      "Authorization": "Bearer " + token
    }
  });

  if (!response.ok) {
    alert("Download failed: " + await response.text());
    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

function downloadClientCertificate(name) {
  downloadAuthenticatedFile(
    "/certificates/client/" + encodeURIComponent(name) + "/download",
    name + ".pfx"
  );
}

function downloadCaCertificate() {
  downloadAuthenticatedFile(
    "/certificates/ca/download",
    "Radiusaurus-CA.crt"
  );
}

async function deleteClientCertificate(name) {
  const status = document.getElementById("certStatus");

  if (!confirm("Delete certificate '" + name + "'? This removes the key, cert, CSR and PFX files.")) {
    return;
  }

  try {
    status.textContent = "Deleting certificate...";

    const result = await api("/certificates/client/" + encodeURIComponent(name), {
      method: "DELETE"
    });

    status.textContent = "Deleted certificate: " + result.name;

    await loadCertificates();
  } catch (err) {
    status.textContent = "ERROR deleting certificate:\n\n" + err.message;
  }
}

async function revokeClientCertificate(name) {
  const status = document.getElementById("certStatus");

  if (!confirm(
    "Revoke certificate '" + name + "'?\n\n" +
    "The device will no longer be allowed to authenticate."
  )) {
    return;
  }

  try {
    status.textContent = "Revoking certificate...";

    const result = await api(
      "/certificates/client/" + encodeURIComponent(name) + "/revoke",
      {
        method: "POST"
      }
    );

    status.textContent =
      "Certificate revoked: " + result.certificate;

    await loadCertificates();

  } catch (err) {
    status.textContent =
      "ERROR revoking certificate:\n\n" + err.message;
  }
}

//Policies
async function loadPolicies() {
  const output = document.getElementById("policiesOutput");

  try {
    output.innerHTML = "<pre>Loading policies...</pre>";

    const policies = await api("/policies");

    if (!policies.length) {
      output.innerHTML = "<p class='muted'>No policies found.</p>";
      return;
    }

    output.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Group</th>
              <th>Type</th>
              <th>VLAN</th>
              <th>Attribute</th>
              <th>Op</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            ${policies.map(policy => `
              <tr>
                <td><strong>${escapeHtml(policy.group_name)}</strong></td>
                <td>${escapeHtml(policy.group_type || "-")}</td>
                <td>
                  ${policy.vlan_number
                    ? escapeHtml(policy.vlan_number + " - " + (policy.vlan_name || ""))
                    : "-"
                  }
                </td>
                <td>${escapeHtml(policy.attribute || "-")}</td>
                <td>${escapeHtml(policy.op || "-")}</td>
                <td>${escapeHtml(policy.value || "-")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    output.innerHTML = `<pre>ERROR loading policies:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

//users
async function loadUsers() {
  try {
    showOutput("Loading users...");

    const users = await api("/users");
    const macs = await api("/mac-addresses");
    const groups = await api("/groups");

    cachedUsers = users;
    cachedMacs = macs;
    cachedGroups = groups;

    populateUserGroupDropdowns(groups);
    populateMacUserDropdown(users);

    showOutput(users);
  } catch (err) {
    showOutput("ERROR loading users:\n\n" + err.message);
  }
}

async function createUser() {
  try {
    const body = {
      username: document.getElementById("newUsername").value,
      password: document.getElementById("newPassword").value,
      group: document.getElementById("newGroup").value || "default"
    };

    if (!body.username || !body.password) {
      showOutput("Username and password are required.");
      return;
    }

    showOutput("Creating user...");

    await api("/users", {
      method: "POST",
      body: JSON.stringify(body)
    });

    document.getElementById("newUsername").value = "";
    document.getElementById("newPassword").value = "";

    await loadUsers();
  } catch (err) {
    showOutput("ERROR creating user:\n\n" + err.message);
  }
}

async function deleteUser(username) {
  if (!confirm("Delete user '" + username + "'?")) return;

  try {
    showOutput("Deleting user...");
    await api("/users/" + encodeURIComponent(username), {
      method: "DELETE"
    });
    await loadUsers();
  } catch (err) {
    showOutput("ERROR deleting user:\n\n" + err.message);
  }
}

function editUser(username, groupName) {
  document.getElementById("editUserBox").style.display = "block";
  document.getElementById("editUsername").value = username;
  document.getElementById("editUsernameDisplay").value = username;
  document.getElementById("editPassword").value = "";

  const editGroup = document.getElementById("editGroup");
  if (groupName && groupName !== "-") editGroup.value = groupName;

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelUserEdit() {
  document.getElementById("editUserBox").style.display = "none";
  document.getElementById("editUsername").value = "";
  document.getElementById("editUsernameDisplay").value = "";
  document.getElementById("editPassword").value = "";
}

async function saveUserEdit() {
  const username = document.getElementById("editUsername").value;
  const password = document.getElementById("editPassword").value;
  const group = document.getElementById("editGroup").value;

  try {
    showOutput("Updating user...");

    await api("/users/" + encodeURIComponent(username), {
      method: "PUT",
      body: JSON.stringify({
        password: password || null,
        group: group || null
      })
    });

    cancelUserEdit();
    await loadUsers();
  } catch (err) {
    showOutput("ERROR updating user:\n\n" + err.message);
  }
}

//Mac Adresses
function showMacOutput(data) {
  const output = document.getElementById("macOutput");

  if (typeof data === "string") {
    output.innerHTML = `<pre>${escapeHtml(data)}</pre>`;
    return;
  }

  if (!data.length) {
    output.innerHTML = "<p class='muted'>No MAC addresses found.</p>";
    return;
  }

  output.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>MAC</th>
            <th>User</th>
            <th>Device</th>
            <th>Description</th>
            <th>VLAN</th>
            <th>Group</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${data.map(item => `
            <tr>
              <td><strong>${formatMac(item.mac)}</strong></td>
              <td>${escapeHtml(item.username || "Shared / none")}</td>
              <td>${escapeHtml(item.device_name || "-")}</td>
              <td>${escapeHtml(item.description || "-")}</td>
              <td>${item.vlan_number ? escapeHtml(item.vlan_number + " - " + (item.vlan_name || "")) : "-"}</td>
              <td>${escapeHtml(item.groupname || "-")}</td>
              <td>
                <button class="small-btn" onclick="editMacAddress('${escapeJs(item.mac)}')">Edit</button>
                <button class="delete-btn" onclick="deleteMacAddress('${escapeJs(item.mac)}')">Delete</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function addMacAddress() {
  try {
    const body = {
      mac: document.getElementById("macAddress").value,
      username: document.getElementById("macUser").value || null,
      device_name: document.getElementById("macDeviceName").value,
      description: document.getElementById("macDescription").value || null,
      group: document.getElementById("macGroup").value || "mac-auth",
      vlan_number: document.getElementById("macVlan").value ? Number(document.getElementById("macVlan").value) : null
    };

    if (!body.mac) {
      showMacOutput("MAC address is required.");
      return;
    }

    if (!body.device_name) {
      showMacOutput("Device name is required.");
      return;
    }

    showMacOutput("Adding MAC address...");

    const result = await api("/mac-addresses", {
      method: "POST",
      body: JSON.stringify(body)
    });

    document.getElementById("macAddress").value = "";
    document.getElementById("macDeviceName").value = "";
    document.getElementById("macDescription").value = "";

    showMacOutput(result);
    await loadMacAddresses();
  } catch (err) {
    showMacOutput("ERROR adding MAC:\n\n" + err.message);
  }
}

function editMacAddress(mac) {
  const item = cachedMacs.find(m => m.mac === mac);
  if (!item) return;

  document.getElementById("editMacBox").style.display = "block";
  document.getElementById("editMacOriginal").value = item.mac;
  document.getElementById("editMacDisplay").value = formatMac(item.mac);
  document.getElementById("editMacUser").value = item.username || "";
  document.getElementById("editMacDeviceName").value = item.device_name || "";
  document.getElementById("editMacDescription").value = item.description || "";
  document.getElementById("editMacGroup").value = item.groupname || "mac-auth";
  document.getElementById("editMacVlan").value = item.vlan_number || "";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelMacEdit() {
  document.getElementById("editMacBox").style.display = "none";
}

async function saveMacEdit() {
  const mac = document.getElementById("editMacOriginal").value;

  const body = {
    username: document.getElementById("editMacUser").value || null,
    device_name: document.getElementById("editMacDeviceName").value,
    description: document.getElementById("editMacDescription").value || null,
    group: document.getElementById("editMacGroup").value || "mac-auth",
    vlan_number: document.getElementById("editMacVlan").value ? Number(document.getElementById("editMacVlan").value) : null
  };

  try {
    await api("/mac-addresses/" + encodeURIComponent(mac), {
      method: "PUT",
      body: JSON.stringify(body)
    });

    cancelMacEdit();
    await loadMacPageData();
  } catch (err) {
    showMacOutput("ERROR updating MAC:\n\n" + err.message);
  }
}

async function deleteMacAddress(mac) {
  if (!confirm("Delete MAC address '" + formatMac(mac) + "'?")) return;

  try {
    showMacOutput("Deleting MAC address...");
    await api("/mac-addresses/" + encodeURIComponent(mac), {
      method: "DELETE"
    });
    await loadMacAddresses();
  } catch (err) {
    showMacOutput("ERROR deleting MAC:\n\n" + err.message);
  }
}

async function loadMacPageData() {
  try {
    const users = await api("/users");
    const vlans = await api("/vlans");

    cachedUsers = users;
    cachedVlans = vlans;

    populateMacUserDropdown(users);
    populateMacVlanDropdown(vlans);

    await loadMacAddresses();
  } catch (err) {
    showMacOutput("ERROR loading MAC page:\n\n" + err.message);
  }
}

async function loadMacAddresses() {
  try {
    showMacOutput("Loading MAC addresses...");
    const macs = await api("/mac-addresses");
    cachedMacs = macs;
    showMacOutput(macs);
  } catch (err) {
    showMacOutput("ERROR loading MACs:\n\n" + err.message);
  }
}

//Groups 
async function loadGroups() {
  const output = document.getElementById("groupsOutput");

  try {
    output.innerHTML = "<pre>Loading groups...</pre>";

    const groups = await api("/groups");
    const vlans = await api("/vlans");

    cachedGroups = groups;
    cachedVlans = vlans;

    populateGroupVlanDropdowns(vlans);

    if (!groups.length) {
      output.innerHTML = "<p class='muted'>No groups found.</p>";
      return;
    }

    output.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Group name</th>
              <th>Type</th>
              <th>VLAN</th>
              <th>Session</th>
              <th>Idle</th>
              <th>Aruba role</th>
              <th>Filter-Id</th>
              <th>Members</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${groups.map(group => `
              <tr>
                <td><strong>${escapeHtml(group.group_name)}</strong></td>
                <td>${escapeHtml(group.group_type)}</td>
                <td>${group.vlan_number ? escapeHtml(group.vlan_number + " - " + (group.vlan_name || "")) : "-"}</td>
                <td>${group.session_timeout || "-"}</td>
                <td>${group.idle_timeout || "-"}</td>
                <td>${escapeHtml(group.aruba_role || "-")}</td>
                <td>${escapeHtml(group.filter_id || "-")}</td>
                <td>${group.member_count || 0}</td>
                <td>
                  <button class="small-btn" onclick="editGroup('${escapeJs(group.group_name)}')">Edit</button>
                  <button class="delete-btn" onclick="deleteGroup('${escapeJs(group.group_name)}')">Delete</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    output.innerHTML = `<pre>ERROR loading groups:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

async function createGroup() {
  const output = document.getElementById("groupsOutput");

  try {
    const body = {
      group_name: document.getElementById("groupName").value,
      group_type: document.getElementById("groupType").value,
      vlan_number: document.getElementById("groupVlan").value ? Number(document.getElementById("groupVlan").value) : null,
      session_timeout: document.getElementById("groupSessionTimeout").value ? Number(document.getElementById("groupSessionTimeout").value) : null,
      idle_timeout: document.getElementById("groupIdleTimeout").value ? Number(document.getElementById("groupIdleTimeout").value) : null,
      aruba_role: document.getElementById("groupArubaRole").value || null,
      filter_id: document.getElementById("groupFilterId").value || null,
      allow_peap: true,
      allow_ttls: true,
      allow_mab: true
    };

    if (!body.group_name || !body.group_type) {
      output.innerHTML = "<pre>Group name and type are required.</pre>";
      return;
    }

    await api("/groups", {
      method: "POST",
      body: JSON.stringify(body)
    });

    document.getElementById("groupName").value = "";
    document.getElementById("groupType").value = "";
    document.getElementById("groupVlan").value = "";
    document.getElementById("groupSessionTimeout").value = "";
    document.getElementById("groupIdleTimeout").value = "";
    document.getElementById("groupArubaRole").value = "";
    document.getElementById("groupFilterId").value = "";

    await loadGroups();
  } catch (err) {
    output.innerHTML = `<pre>ERROR creating group:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

function editGroup(groupName) {
  const group = cachedGroups.find(g => g.group_name === groupName);
  if (!group) return;

  document.getElementById("editGroupBox").style.display = "block";
  document.getElementById("editGroupNameOriginal").value = group.group_name;
  document.getElementById("editGroupNameDisplay").value = group.group_name;
  document.getElementById("editGroupType").value = group.group_type || "";
  document.getElementById("editGroupVlan").value = group.vlan_number || "";
  document.getElementById("editGroupSessionTimeout").value = group.session_timeout || "";
  document.getElementById("editGroupIdleTimeout").value = group.idle_timeout || "";
  document.getElementById("editGroupArubaRole").value = group.aruba_role || "";
  document.getElementById("editGroupFilterId").value = group.filter_id || "";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelGroupEdit() {
  document.getElementById("editGroupBox").style.display = "none";
}

async function saveGroupEdit() {
  const groupName = document.getElementById("editGroupNameOriginal").value;

  const body = {
    group_type: document.getElementById("editGroupType").value,
    vlan_number: document.getElementById("editGroupVlan").value ? Number(document.getElementById("editGroupVlan").value) : null,
    session_timeout: document.getElementById("editGroupSessionTimeout").value ? Number(document.getElementById("editGroupSessionTimeout").value) : null,
    idle_timeout: document.getElementById("editGroupIdleTimeout").value ? Number(document.getElementById("editGroupIdleTimeout").value) : null,
    aruba_role: document.getElementById("editGroupArubaRole").value || null,
    filter_id: document.getElementById("editGroupFilterId").value || null,
    allow_peap: true,
    allow_ttls: true,
    allow_mab: true
  };

  try {
    await api("/groups/" + encodeURIComponent(groupName), {
      method: "PUT",
      body: JSON.stringify(body)
    });

    cancelGroupEdit();
    await loadGroups();
  } catch (err) {
    document.getElementById("groupsOutput").innerHTML =
      `<pre>ERROR updating group:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

async function deleteGroup(groupName) {
  if (!confirm("Delete group '" + groupName + "'?")) return;

  const output = document.getElementById("groupsOutput");

  try {
    output.innerHTML = "<pre>Deleting group...</pre>";
    await api("/groups/" + encodeURIComponent(groupName), {
      method: "DELETE"
    });
    await loadGroups();
  } catch (err) {
    output.innerHTML = `<pre>ERROR deleting group:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

//Vlans
async function loadVlans() {
  const output = document.getElementById("vlansOutput");

  try {
    output.innerHTML = "<pre>Loading VLANs...</pre>";
    const vlans = await api("/vlans");
    cachedVlans = vlans;

    if (!vlans.length) {
      output.innerHTML = "<p class='muted'>No VLANs found.</p>";
      return;
    }

    output.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Name</th>
              <th>Location</th>
              <th>Description</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${vlans.map(vlan => `
              <tr>
                <td><strong>${escapeHtml(vlan.vlan_number)}</strong></td>
                <td>${escapeHtml(vlan.vlan_name)}</td>
                <td>${escapeHtml(vlan.location || "-")}</td>
                <td>${escapeHtml(vlan.description || "-")}</td>
                <td>
                  <button class="small-btn" onclick="editVlan('${escapeJs(vlan.vlan_number)}')">Edit</button>
                  <button class="delete-btn" onclick="deleteVlan('${escapeJs(vlan.vlan_number)}')">Delete</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    output.innerHTML = `<pre>ERROR loading VLANs:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

async function createVlan() {
  const output = document.getElementById("vlansOutput");

  try {
    const body = {
      vlan_number: Number(document.getElementById("vlanNumber").value),
      vlan_name: document.getElementById("vlanName").value,
      location: document.getElementById("vlanLocation").value || null,
      description: document.getElementById("vlanDescription").value || null
    };

    if (!body.vlan_number || !body.vlan_name) {
      output.innerHTML = "<pre>VLAN number and name are required.</pre>";
      return;
    }

    await api("/vlans", {
      method: "POST",
      body: JSON.stringify(body)
    });

    document.getElementById("vlanNumber").value = "";
    document.getElementById("vlanName").value = "";
    document.getElementById("vlanLocation").value = "";
    document.getElementById("vlanDescription").value = "";

    await loadVlans();
  } catch (err) {
    output.innerHTML = `<pre>ERROR creating VLAN:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

function editVlan(vlanNumber) {
  const vlan = cachedVlans.find(v => String(v.vlan_number) === String(vlanNumber));
  if (!vlan) return;

  document.getElementById("editVlanBox").style.display = "block";
  document.getElementById("editVlanNumberOriginal").value = vlan.vlan_number;
  document.getElementById("editVlanNumberDisplay").value = vlan.vlan_number;
  document.getElementById("editVlanName").value = vlan.vlan_name || "";
  document.getElementById("editVlanLocation").value = vlan.location || "";
  document.getElementById("editVlanDescription").value = vlan.description || "";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelVlanEdit() {
  document.getElementById("editVlanBox").style.display = "none";
}

async function saveVlanEdit() {
  const vlanNumber = document.getElementById("editVlanNumberOriginal").value;

  const body = {
    vlan_name: document.getElementById("editVlanName").value,
    location: document.getElementById("editVlanLocation").value || null,
    description: document.getElementById("editVlanDescription").value || null
  };

  try {
    await api("/vlans/" + encodeURIComponent(vlanNumber), {
      method: "PUT",
      body: JSON.stringify(body)
    });

    cancelVlanEdit();
    await loadVlans();
  } catch (err) {
    document.getElementById("vlansOutput").innerHTML =
      `<pre>ERROR updating VLAN:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

async function deleteVlan(vlanNumber) {
  if (!confirm("Delete VLAN '" + vlanNumber + "'?")) return;

  const output = document.getElementById("vlansOutput");

  try {
    output.innerHTML = "<pre>Deleting VLAN...</pre>";
    await api("/vlans/" + encodeURIComponent(vlanNumber), {
      method: "DELETE"
    });
    await loadVlans();
  } catch (err) {
    output.innerHTML = `<pre>ERROR deleting VLAN:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

//Clients
async function loadClients() {
  const output = document.getElementById("clientsOutput");

  try {
    output.innerHTML = "<pre>Loading RADIUS clients...</pre>";
    const clients = await api("/clients");
    cachedClients = clients;

    if (!clients.length) {
      output.innerHTML = "<p class='muted'>No RADIUS clients found.</p>";
      return;
    }

    output.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name / IP</th>
              <th>Short name</th>
              <th>Type</th>
              <th>Secret</th>
              <th>Description</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${clients.map(client => `
              <tr>
                <td><strong>${escapeHtml(client.nasname)}</strong></td>
                <td>${escapeHtml(client.shortname || "-")}</td>
                <td>${escapeHtml(client.type || "-")}</td>
                <td>••••••••</td>
                <td>${escapeHtml(client.description || "-")}</td>
                <td>
                  <button class="small-btn" onclick="editClient('${escapeJs(client.id)}')">Edit</button>
                  <button class="delete-btn" onclick="deleteClient('${escapeJs(client.id)}')">Delete</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    output.innerHTML = `<pre>ERROR loading clients:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

async function createClient() {
  const output = document.getElementById("clientsOutput");

  try {
    const body = {
      nasname: document.getElementById("clientNasname").value,
      shortname: document.getElementById("clientShortname").value,
      secret: document.getElementById("clientSecret").value,
      type: document.getElementById("clientType").value || "other",
      description: document.getElementById("clientDescription").value || null
    };

    if (!body.nasname || !body.shortname || !body.secret) {
      output.innerHTML = "<pre>Name/IP, short name, and secret are required.</pre>";
      return;
    }

    await api("/clients", {
      method: "POST",
      body: JSON.stringify(body)
    });

    document.getElementById("clientNasname").value = "";
    document.getElementById("clientShortname").value = "";
    document.getElementById("clientSecret").value = "";
    document.getElementById("clientType").value = "other";
    document.getElementById("clientDescription").value = "";

    await loadClients();
  } catch (err) {
    output.innerHTML = `<pre>ERROR creating client:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

function editClient(id) {
  const client = cachedClients.find(c => String(c.id) === String(id));
  if (!client) return;

  document.getElementById("editClientBox").style.display = "block";
  document.getElementById("editClientId").value = client.id;
  document.getElementById("editClientNasname").value = client.nasname || "";
  document.getElementById("editClientShortname").value = client.shortname || "";
  document.getElementById("editClientSecret").value = client.secret || "";
  document.getElementById("editClientType").value = client.type || "other";
  document.getElementById("editClientDescription").value = client.description || "";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelClientEdit() {
  document.getElementById("editClientBox").style.display = "none";
}

async function saveClientEdit() {
  const id = document.getElementById("editClientId").value;

  const body = {
    nasname: document.getElementById("editClientNasname").value,
    shortname: document.getElementById("editClientShortname").value,
    secret: document.getElementById("editClientSecret").value,
    type: document.getElementById("editClientType").value || "other",
    description: document.getElementById("editClientDescription").value || null
  };

  try {
    await api("/clients/" + encodeURIComponent(id), {
      method: "PUT",
      body: JSON.stringify(body)
    });

    cancelClientEdit();
    await loadClients();
  } catch (err) {
    document.getElementById("clientsOutput").innerHTML =
      `<pre>ERROR updating client:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

async function deleteClient(id) {
  if (!confirm("Delete this RADIUS client?")) return;

  try {
    document.getElementById("clientsOutput").innerHTML = "<pre>Deleting client...</pre>";
    await api("/clients/" + encodeURIComponent(id), {
      method: "DELETE"
    });
    await loadClients();
  } catch (err) {
    document.getElementById("clientsOutput").innerHTML =
      `<pre>ERROR deleting client:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

//Logs
async function loadLogs() {
  viewingLogDetails = false;
  try {
    const data = await api("/logs");

    const failedOnly =
      document.getElementById("logFilterFailed").value === "failed";

    const userFilter =
      document.getElementById("logFilterUser").value.toLowerCase();

    let html = "";

    data.forEach(log => {
      const accepted =
        log.reply &&
        log.reply.toLowerCase().includes("accept");

      if (failedOnly && accepted) return;

      if (
        userFilter &&
        !String(log.username || "").toLowerCase().includes(userFilter)
      ) return;

      html += `
        <div onclick='showLogDetails(${JSON.stringify(log).replaceAll("'", "&#039;")})' style="
          padding:16px;
          border-radius:16px;
          margin-bottom:14px;
          cursor:pointer;
          background:${accepted ? '#ecfdf5' : '#fef2f2'};
          border:1px solid ${accepted ? '#bbf7d0' : '#fecaca'};
        ">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <strong>${escapeHtml(log.username || "-")}</strong>
            <span style="color:${accepted ? '#15803d' : '#dc2626'};font-weight:700;">
              ${escapeHtml(log.reply || "-")}
            </span>
          </div>

          <div class="muted">
            ${escapeHtml(formatLocalTime(log.authdate))}
          </div>
        </div>
      `;
    });

    document.getElementById("logsOutput").innerHTML =
      html || "<p class='muted'>No logs found.</p>";

  } catch (err) {
    console.error(err);

    document.getElementById("logsOutput").innerHTML =
      `<pre>ERROR loading logs:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

async function exportLogsCsv() {
  try {
    const data = await api("/logs?limit=100000");

    if (!data.length) {
      alert("No logs to export.");
      return;
    }

    const columns = [
      "id",
      "authdate",
      "username",
      "pass",
      "reply",
      "class",
      "packet_type",
      "nas_ip_address",
      "client_ip_address",
      "calling_station_id",
      "called_station_id",
      "module_failure_message"
    ];

    const csv = [
      columns.join(","),
      ...data.map(row =>
        columns.map(col => csvEscape(row[col])).join(",")
      )
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "radiusaurus-logs.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  } catch (err) {
    alert("ERROR exporting logs:\n\n" + err.message);
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function showLogDetails(log) {
  viewingLogDetails = true;
  const accepted =
    log.reply &&
    log.reply.toLowerCase().includes("accept");

  document.getElementById("logsOutput").innerHTML = `
    <button class="full" onclick="loadLogs()" style="margin-bottom:18px;background:#64748b">
      Back to logs
    </button>

    <div style="
      padding:16px;
      border-radius:16px;
      margin-bottom:18px;
      background:${accepted ? '#ecfdf5' : '#fef2f2'};
      border:1px solid ${accepted ? '#bbf7d0' : '#fecaca'};
    ">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>${escapeHtml(log.username || "-")}</strong>
        <span style="color:${accepted ? '#15803d' : '#dc2626'};font-weight:700;">
          ${escapeHtml(log.reply || "-")}
        </span>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <tbody>
          <tr><th>ID</th><td>${escapeHtml(log.id || "-")}</td></tr>
          <tr><th>Local time</th><td>${escapeHtml(formatLocalTime(log.authdate))}</td></tr>
          <tr><th>UTC time</th><td>${escapeHtml(log.authdate || "-")}</td></tr>
          <tr><th>User / MAC</th><td>${escapeHtml(log.username || "-")}</td></tr>
          <tr><th>Password / MAC auth value</th><td>${escapeHtml(log.pass || "-")}</td></tr>
          <tr><th>Result</th><td>${escapeHtml(log.reply || "-")}</td></tr>
          <tr><th>Class</th><td>${escapeHtml(log.class || "-")}</td></tr>
          <tr><th>Packet type</th><td>${escapeHtml(log.packet_type || "-")}</td></tr>
          <tr><th>NAS IP</th><td>${escapeHtml(log.nas_ip_address || "-")}</td></tr>
          <tr><th>Client IP</th><td>${escapeHtml(log.client_ip_address || "-")}</td></tr>
          <tr><th>Calling Station / Device MAC</th><td>${escapeHtml(log.calling_station_id || "-")}</td></tr>
          <tr><th>Called Station / AP SSID</th><td>${escapeHtml(log.called_station_id || "-")}</td></tr>
          <tr><th>Reason</th><td>${escapeHtml(log.module_failure_message || "-")}</td></tr>
          <tr><th>Framed Protocol</th><td>${escapeHtml(log.framed_protocol || "-")}</td></tr>
          <tr><th>Framed Compression</th><td>${escapeHtml(log.framed_compression || "-")}</td></tr>
          <tr><th>Tunnel Type</th><td>${escapeHtml(log.tunnel_type || "-")}</td></tr>
          <tr><th>Tunnel Medium Type</th><td>${escapeHtml(log.tunnel_medium_type || "-")}</td></tr>
          <tr><th>Assigned VLAN</th><td>${escapeHtml(log.tunnel_private_group_id || "-")}</td></tr>
        </tbody>
      </table>
    </div>
  `;
}
//Config Files

async function loadConfigFiles() {
  const output = document.getElementById("configFilesList");

  try {
    const files = await api("/config-files");

    output.innerHTML = files.map(file => `
      <button class="full" style="margin-bottom:10px;text-align:left" onclick="openConfigFile('${escapeJs(file.key)}')">
        <strong>${escapeHtml(file.key)}</strong><br>
        <span class="muted">${escapeHtml(file.path)}</span>
      </button>
    `).join("");
  } catch (err) {
    output.innerHTML = `<pre>ERROR loading config files:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

async function openConfigFile(key) {
  const status = document.getElementById("configFileStatus");

  try {
    status.textContent = "Loading...";
    const file = await api("/config-files/" + encodeURIComponent(key));

    selectedConfigFileKey = key;
    document.getElementById("configFileTitle").textContent = file.path;
    document.getElementById("configFileEditor").value = file.content || "";

    status.textContent = "Loaded.";
  } catch (err) {
    status.textContent = "ERROR loading file:\n\n" + err.message;
  }
}

async function saveConfigFile() {
  const status = document.getElementById("configFileStatus");

  if (!selectedConfigFileKey) {
    status.textContent = "Select a config file first.";
    return;
  }

  if (!confirm("Save this config file? A backup will be created first.")) {
    return;
  }

  try {
    status.textContent = "Saving...";

    const result = await api("/config-files/" + encodeURIComponent(selectedConfigFileKey), {
      method: "PUT",
      body: JSON.stringify({
        key: selectedConfigFileKey,
        content: document.getElementById("configFileEditor").value
      })
    });

    status.textContent = "Saved.\nBackup: " + result.backup;
  } catch (err) {
    status.textContent = "ERROR saving file:\n\n" + err.message;
  }
}

async function testFreeradiusConfig() {
  const status = document.getElementById("generatedConfigStatus");

  try {
    status.textContent = "Testing FreeRADIUS configuration...";

    const result = await api("/config-files/test", {
      method: "POST"
    });

    status.textContent =
      "CONFIG TEST RESULT\n" +
      "==================\n\n" +

      "SUCCESS: " + (result.ok ? "YES" : "NO") + "\n\n" +

      "STDOUT:\n" +
      "------------------\n" +
      (result.stdout || "(empty)") +

      "\n\nSTDERR:\n" +
      "------------------\n" +
      (result.stderr || "(empty)");
  } catch (err) {
    status.textContent =
      "ERROR RUNNING CONFIG TEST\n\n" + err.message;
  }
}

async function reloadFreeradius() {
  const status = document.getElementById("configFileStatus");

  if (!confirm("Reload FreeRADIUS now? Only do this after config test passes.")) {
    return;
  }

  try {
    status.textContent = "Reloading FreeRADIUS...";
    const result = await api("/config-files/reload", { method: "POST" });

    status.textContent =
      (result.ok ? "RELOAD OK\n\n" : "RELOAD FAILED\n\n") +
      (result.stdout || "") +
      "\n" +
      (result.stderr || "");
  } catch (err) {
    status.textContent = "ERROR reloading FreeRADIUS:\n\n" + err.message;
  }
}

//Settings
async function generateFreeradiusFile(endpoint, label) {
  const status = document.getElementById("generatedConfigStatus");

  if (!confirm("Generate " + label + "? A backup will be created first.")) {
    return;
  }

  try {
    status.textContent = "Generating " + label + "...";

    const result = await api(endpoint, {
      method: "POST"
    });

    status.textContent =
      "Generated " + label + ":\n" +
      result.file +
      "\n\nBackup:\n" +
      (result.backup || "No previous file existed.");
  } catch (err) {
    status.textContent = "ERROR:\n\n" + err.message;
  }
}

function generateRadiusRequestLogConfig() {
  generateFreeradiusFile(
    "/settings/generate/radius-request-log",
    "radius_request_log config"
  );
}

function generateQueriesConf() {
  generateFreeradiusFile(
    "/settings/generate/queries-conf",
    "queries.conf"
  );
}

function generateSqlConfig() {
  generateFreeradiusFile("/settings/generate/sql", "SQL config");
}

function generateEapConfig() {
  generateFreeradiusFile("/settings/generate/eap", "EAP config");
}

function generateDefaultSiteConfig() {
  generateFreeradiusFile("/settings/generate/default-site", "default site");
}

function generateInnerTunnelConfig() {
  generateFreeradiusFile("/settings/generate/inner-tunnel", "inner-tunnel");
}

async function generateAllFreeradiusConfigs() {
  const status = document.getElementById("generatedConfigStatus");

  if (!confirm("Generate all managed FreeRADIUS configs? Backups will be created first.")) {
    return;
  }

  try {
    status.textContent = "Generating all configs...";

    const result = await api("/settings/generate/all", {
      method: "POST"
    });

    status.textContent =
      "Generated all configs.\n\n" +
      JSON.stringify(result, null, 2);
  } catch (err) {
    status.textContent = "ERROR:\n\n" + err.message;
  }
}

async function generateClientsConf() {
  const status = document.getElementById("generatedConfigStatus");

  if (!confirm("Generate clients.conf from Radiusaurus clients? A backup will be created first.")) {
    return;
  }

  try {
    status.textContent = "Generating clients.conf...";

    const result = await api("/settings/generate/clients-conf", {
      method: "POST"
    });

    status.textContent =
      "Generated:\n" +
      result.file +
      "\n\nBackup:\n" +
      (result.backup || "No previous file existed.");
  } catch (err) {
    status.textContent = "ERROR:\n\n" + err.message;
  }
}

async function loadClientSetupSettings() {
  const settings = await api("/settings");

  const setText = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  };

  setText("setupRadiusIp", settings.radius_server_ip || "-");
  setText("setupRadiusDns", settings.radius_server_dns || "-");
  setText("setupAuthPort", "UDP " + (settings.auth_port || 1812));
  setText("setupAccountingPort", "UDP " + (settings.accounting_port || 1813));
}

async function deployFreeradiusConfigs() {
  const status = document.getElementById("generatedConfigStatus");

  if (!confirm("Generate all configs, test FreeRADIUS, and reload if the test passes?")) {
    return;
  }

  try {
    status.textContent = "Generating all managed configs...";

    const generated = await api("/settings/generate/all", {
      method: "POST"
    });

    status.textContent =
      "Generated configs:\n\n" +
      JSON.stringify(generated, null, 2) +
      "\n\nTesting FreeRADIUS config...";

    const test = await api("/config-files/test", {
      method: "POST"
    });

    if (!test.ok) {
      status.textContent =
        "Generated configs, but FreeRADIUS test FAILED.\n\n" +
        "STDOUT:\n" + (test.stdout || "(empty)") +
        "\n\nSTDERR:\n" + (test.stderr || "(empty)");

      return;
    }

    status.textContent =
      "FreeRADIUS config test passed.\n\nReloading FreeRADIUS...";

    const reload = await api("/config-files/reload", {
      method: "POST"
    });

    status.textContent =
      "DEPLOYMENT COMPLETE\n\n" +
      "Generated:\n" +
      JSON.stringify(generated, null, 2) +
      "\n\nTest:\n" +
      (test.stdout || "(empty)") +
      "\n\nReload:\n" +
      (reload.stdout || "(empty)") +
      "\n" +
      (reload.stderr || "");
  } catch (err) {
    status.textContent = "ERROR:\n\n" + err.message;
  }
}

async function loadSettings() {
  const status = document.getElementById("settingsStatus");

  try {
    status.textContent = "Loading settings...";

    const settings = await api("/settings");

    document.getElementById("settingsCompanyName").value =
      settings.company_name || "";

    document.getElementById("settingsSupportEmail").value =
      settings.support_email || "";

    document.getElementById("settingsRadiusIp").value =
      settings.radius_server_ip || "";

    document.getElementById("settingsRadiusDns").value =
      settings.radius_server_dns || "";

    document.getElementById("settingsAuthPort").value =
      settings.auth_port || 1812;

    document.getElementById("settingsAccountingPort").value =
      settings.accounting_port || 1813;

    document.getElementById("settingsCertCountry").value =
      settings.certificate_country || "";

    document.getElementById("settingsCertState").value =
      settings.certificate_state || "";

    document.getElementById("settingsCertOrg").value =
      settings.certificate_organization || "";
    document.getElementById("settingsClientsConf").value =
      settings.freeradius_clients_conf || "/etc/freeradius/3.0/clients.conf";

    document.getElementById("settingsEapConf").value =
      settings.freeradius_eap_conf || "/etc/freeradius/3.0/mods-enabled/eap";

    document.getElementById("settingsDefaultSite").value =
      settings.freeradius_default_site || "/etc/freeradius/3.0/sites-enabled/default";

    document.getElementById("settingsInnerTunnel").value =
      settings.freeradius_inner_tunnel || "/etc/freeradius/3.0/sites-enabled/inner-tunnel";

    document.getElementById("settingsBackupDir").value =
      settings.freeradius_backup_dir || "/opt/radiusaurus/backups/generated-configs";

    document.getElementById("settingsDefaultEapType").value =
      settings.freeradius_default_eap_type || "peap";

    document.getElementById("settingsPublicUrl").value =
      settings.server_public_url || "";

    document.getElementById("settingsFrontendPath").value =
      settings.frontend_path || "/var/www/radiusaurus";

    document.getElementById("settingsFreeradiusService").value =
      settings.freeradius_service_name || "freeradius";

    document.getElementById("settingsFreeradiusBinary").value =
      settings.freeradius_binary_path || "/usr/sbin/freeradius";

    document.getElementById("settingsDefaultUserGroup").value =
      settings.default_user_group || "default";

    document.getElementById("settingsDefaultMacGroup").value =
      settings.default_mac_group || "mac-auth";

    document.getElementById("settingsCertificateValidDays").value =
      settings.certificate_valid_days_default || 365;

    document.getElementById("settingsLogRetentionDays").value =
      settings.log_retention_days || 30;

    document.getElementById("settingsBackupRetentionDays").value =
      settings.backup_retention_days || 30;

    status.textContent = "Loaded.";
  } catch (err) {
    status.textContent = "ERROR:\n\n" + err.message;
  }
}

async function saveSettings() {
  const status = document.getElementById("settingsStatus");

  try {
    status.textContent = "Saving settings...";

    await api("/settings", {
      method: "PUT",
      body: JSON.stringify({
        company_name:
          document.getElementById("settingsCompanyName").value,

        support_email:
          document.getElementById("settingsSupportEmail").value,

        radius_server_ip:
          document.getElementById("settingsRadiusIp").value,

        radius_server_dns:
          document.getElementById("settingsRadiusDns").value,

        auth_port:
          Number(document.getElementById("settingsAuthPort").value),

        accounting_port:
          Number(document.getElementById("settingsAccountingPort").value),

        certificate_country:
          document.getElementById("settingsCertCountry").value,

        certificate_state:
          document.getElementById("settingsCertState").value,

        certificate_organization:
          document.getElementById("settingsCertOrg").value,

        certificate_ca_password:
          document.getElementById("settingsCaPassword").value,

        freeradius_clients_conf:
          document.getElementById("settingsClientsConf").value,

        freeradius_eap_conf:
          document.getElementById("settingsEapConf").value,

        freeradius_default_site:
          document.getElementById("settingsDefaultSite").value,

        freeradius_inner_tunnel:
          document.getElementById("settingsInnerTunnel").value,

        freeradius_backup_dir:
          document.getElementById("settingsBackupDir").value,

        freeradius_default_eap_type:
          document.getElementById("settingsDefaultEapType").value,

        server_public_url:
          document.getElementById("settingsPublicUrl").value,

        frontend_path:
          document.getElementById("settingsFrontendPath").value,

        freeradius_service_name:
          document.getElementById("settingsFreeradiusService").value,

        freeradius_binary_path:
          document.getElementById("settingsFreeradiusBinary").value,

        default_user_group:
          document.getElementById("settingsDefaultUserGroup").value,

        default_mac_group:
          document.getElementById("settingsDefaultMacGroup").value,

        certificate_valid_days_default:
          Number(document.getElementById("settingsCertificateValidDays").value),

        log_retention_days:
          Number(document.getElementById("settingsLogRetentionDays").value),

        backup_retention_days:
          Number(document.getElementById("settingsBackupRetentionDays").value)
      })
    });

    status.textContent = "Settings saved.";
  } catch (err) {
    status.textContent = "ERROR:\n\n" + err.message;
  }
}

async function toggleClientExamples(event) {
  const box = document.getElementById("clientExamplesBox");
  const button = event.target;

  if (box.style.display === "block") {
    box.style.display = "none";
    button.textContent = "Show Examples";
    return;
  }

  button.textContent = "Hide Examples";
  box.style.display = "block";
  box.innerHTML = "<pre>Loading examples...</pre>";

  try {
    const response = await fetch("/pages/client-setup.html");

    if (!response.ok) {
      throw new Error("Could not load client setup examples.");
    }

    box.innerHTML = await response.text();
    await loadClientSetupSettings();
  } catch (err) {
    box.innerHTML = `<pre>ERROR loading examples:\n\n${escapeHtml(err.message)}</pre>`;
  }
}

//Population
async function loadCertificateDropdowns() {
  const users = await api("/users");
  const macs = await api("/mac-addresses");

  const userSelect = document.getElementById("certUsername");
  const macSelect = document.getElementById("certMac");

  userSelect.innerHTML = "<option value=''>No linked user</option>";
  macSelect.innerHTML = "<option value=''>No linked MAC</option>";

  [...new Set(users.map(u => u.username))].filter(Boolean).forEach(username => {
    userSelect.innerHTML += `<option value="${escapeHtml(username)}">${escapeHtml(username)}</option>`;
  });

  macs.forEach(mac => {
    macSelect.innerHTML += `
      <option value="${escapeHtml(mac.mac)}">
        ${escapeHtml(formatMac(mac.mac))} - ${escapeHtml(mac.device_name || "Unnamed")}
      </option>
    `;
  });
}

function populateUserGroupDropdowns(groups) {
  const selects = [
    document.getElementById("newGroup"),
    document.getElementById("editGroup")
  ];

  const groupNames = groups.map(g => g.group_name).filter(Boolean);

  selects.forEach(select => {
    if (!select) return;

    select.innerHTML = "";

    if (!groupNames.length) {
      const option = document.createElement("option");
      option.value = "default";
      option.textContent = "default";
      select.appendChild(option);
      return;
    }

    groupNames.forEach(groupName => {
      const option = document.createElement("option");
      option.value = groupName;
      option.textContent = groupName;
      select.appendChild(option);
    });
  });
}

function populateMacUserDropdown(users) {
  const selects = [
    document.getElementById("macUser"),
    document.getElementById("editMacUser")
  ];

  const uniqueUsers = [...new Set(users.map(u => u.username))].filter(Boolean);

  selects.forEach(select => {
    if (!select) return;

    select.innerHTML = "";

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No user / shared device";
    select.appendChild(empty);

    uniqueUsers.forEach(username => {
      const option = document.createElement("option");
      option.value = username;
      option.textContent = username;
      select.appendChild(option);
    });
  });
}

function populateMacVlanDropdown(vlans) {
  const selects = [
    document.getElementById("macVlan"),
    document.getElementById("editMacVlan")
  ];

  selects.forEach(select => {
    if (!select) return;

    select.innerHTML = "";

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No VLAN";
    select.appendChild(empty);

    vlans.forEach(vlan => {
      const option = document.createElement("option");
      option.value = vlan.vlan_number;
      option.textContent = `${vlan.vlan_number} - ${vlan.vlan_name}`;
      select.appendChild(option);
    });
  });
}

function populateGroupVlanDropdowns(vlans) {
  const selects = [
    document.getElementById("groupVlan"),
    document.getElementById("editGroupVlan")
  ];

  selects.forEach(select => {
    if (!select) return;

    select.innerHTML = "";

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No VLAN";
    select.appendChild(empty);

    vlans.forEach(vlan => {
      const option = document.createElement("option");
      option.value = vlan.vlan_number;
      option.textContent = `${vlan.vlan_number} - ${vlan.vlan_name}`;
      select.appendChild(option);
    });
  });
}

function formatLocalTime(value) {
  if (!value) return "-";

  const date = new Date(String(value).replace(" ", "T") + "Z");

  return date.toLocaleString("nl-BE", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeJs(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");
}

function formatMac(mac) {
  const clean = String(mac || "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (clean.length !== 12) return mac || "-";
  return clean.match(/.{1,2}/g).join(":");
}

function logout() {
  localStorage.removeItem("radiusaurus_token");
  token = null;
  showLogin();
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const error = document.getElementById("error");

  try {
    error.style.display = "none";

    await login(
      document.getElementById("username").value,
      document.getElementById("password").value
    );
  } catch(err) {
    error.style.display = "block";
    error.textContent = err.message;
  }
});

if (token) {
  showApp();
  showPage("status");
} else {
  showLogin();
}

setInterval(() => {
  if (currentPage === "logs" && !viewingLogDetails) {
    loadLogs();
  }
}, 5000);
