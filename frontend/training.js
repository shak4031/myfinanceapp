(() => {
  const units = [
    {
      id: '0',
      title: 'Primer',
      duration: '18 min',
      description: 'The groundwork: crypto vocabulary without the math, how a sensor gets its copy of traffic, and what a connection looks like on the wire.',
      lessons: [
        ['0.1', 'Crypto Vocabulary Without the Math', '6:52', 'Keys, symmetric vs. asymmetric encryption, Diffie-Hellman, hashes, signatures and certificates, explained with everyday analogies. These are the terms you need for the rest of the course.', 'Lesson_0.1_Crypto_Vocabulary_Without_the_Math.mp4'],
        ['0.2', 'How a Sensor Gets Its Copy of Traffic', '5:58', 'Sensors work on a copy, not the original. Learn how TAPs, SPAN ports and packet brokers create that copy, why the sensor needs both directions of every conversation, and how virtual and cloud traffic is captured.', 'Lesson_0.2_How_a_Sensor_Gets_Its_Copy_of_Traffic.mp4'],
        ['0.3', 'Reading a Connection on the Wire', '5:22', 'Follow a TCP handshake and a plain HTTP request packet by packet, then the same request over HTTPS. See exactly what encryption hides and what stays visible without decryption.', 'Lesson_0.3_Reading_a_Connection_on_the_Wire.mp4']
      ]
    },
    {
      id: '1',
      title: 'Why Decryption Matters',
      duration: '10 min',
      description: 'What decryption adds to detection, and the three ways a sensor gets keys.',
      lessons: [
        ['1.1', 'The Envelope and the Letter: Three Attacks Traced', '5:22', 'Trace real attack patterns, including SQL injection, DCSync, a C2 beacon and Log4Shell, encrypted and then decrypted. Learn what metadata alone catches and what it misses.', 'Lesson_1.1_The_Envelope_and_the_Letter_Three_Attacks_Traced.mp4'],
        ['1.2', 'Where the Key Comes From: Derive, Receive or Analyze', '5:10', 'The course’s core model. Keys are either derived with a private key, received from a load balancer or agent, or not available, which leaves you to analyze metadata. Learn the “keys meet packets” rule and apply it to five scenarios.', 'Lesson_1.2_Where_the_Key_Comes_From_Derive_Receive_or_Analyze.mp4']
      ]
    },
    {
      id: '2',
      title: 'TLS in Depth',
      duration: '30 min',
      description: 'Every packet of every major TLS handshake, and what each one means for decryption.',
      lessons: [
        ['2.1', 'SSL and TLS Versions, and What to Flag', '4:54', 'The version timeline from SSL to TLS 1.3, how to read the real version on the wire, and which versions and settings to raise as findings. Includes a “spot the problem” exercise.', 'Lesson_2.1_SSL_and_TLS_Versions_and_What_to_Flag.mp4'],
        ['2.2', 'A Complete HTTPS Transaction with RSA Key Exchange', '5:19', 'Walk every packet of a TLS 1.2 RSA session and see exactly how an uploaded private key decrypts it, and what breaks it.', 'Lesson_2.2_A_Complete_HTTPS_Transaction_with_RSA_Key_Exchange.mp4'],
        ['2.3', 'The Same Transaction with ECDHE Forward Secrecy', '4:53', 'The same session with forward secrecy. Learn what changes in the handshake, why the private key no longer works, and how forwarded session secrets are matched to the right session.', 'Lesson_2.3_The_Same_Transaction_with_ECDHE_Forward_Secrecy.mp4'],
        ['2.4', 'TLS 1.3 Packet by Packet', '5:22', 'The one-round-trip handshake, why almost everything shows up as “Application Data,” the four secrets a sensor needs, and what post-quantum (ML-KEM hybrid) ClientHellos look like.', 'Lesson_2.4_TLS_1.3_Packet_by_Packet.mp4'],
        ['2.5', 'Cipher Suite Drill', '4:27', 'Learn to parse any cipher suite name in seconds, practice on eight real suites, and map each to ExtraHop’s decryption categories.', 'Lesson_2.5_Cipher_Suite_Drill.mp4'],
        ['2.6', 'Resumption, Session Tickets and 0-RTT', '5:04', 'How TLS sessions are resumed, what a resumed handshake looks like on the wire, why resumption can break passive decryption, and the security trade-offs of 0-RTT.', 'Lesson_2.6_Resumption_Session_Tickets_and_0-RTT.mp4']
      ]
    },
    {
      id: '3',
      title: 'Transactions Across Protocols',
      duration: '32 min',
      description: 'Beyond HTTPS. These are the protocols attackers use inside the network, and many encrypt with Kerberos or NTLM keys rather than TLS.',
      lessons: [
        ['3.1', 'A Kerberos Logon and an SMB3 File Read', '7:11', 'Follow a user’s logon and file access packet by packet, through the AS, TGS and AP exchanges into an encrypted SMB3 session. See how a service key unlocks it, what remote-service creation looks like once decrypted, and what the ExtraHop domain controller integration requires.', 'Lesson_3.1_A_Kerberos_Logon_and_an_SMB3_File_Read.mp4'],
        ['3.2', 'NTLM and the Three Kinds of LDAP', '5:01', 'The NTLM three-message exchange and why it’s a detection goldmine. Then learn to tell sealed LDAP, StartTLS and LDAPS apart on the wire, and which decryption method each needs. Includes a directory-reconnaissance example.', 'Lesson_3.2_NTLM_and_the_Three_Kinds_of_LDAP.mp4'],
        ['3.3', 'Remote Management: WinRM and RDP', '5:26', 'Why WinRM on port 5985 is still encrypted, how an RDP connection unfolds from its cleartext negotiation into TLS and CredSSP, and what you can learn before and after decryption.', 'Lesson_3.3_Remote_Management_WinRM_and_RDP.mp4'],
        ['3.4', 'Databases on the Wire', '5:52', 'How SQL Server, PostgreSQL, MySQL and Oracle each start encryption, what leaks before encryption begins, and the SQL Server decryption limitation you must plan around.', 'Lesson_3.4_Databases_on_the_Wire.mp4'],
        ['3.5', 'Email: STARTTLS vs. Implicit TLS', '4:07', 'The SMTP STARTTLS conversation line by line, implicit-TLS ports, STARTTLS stripping, and how to tell the sensor what’s inside TLS on non-standard ports.', 'Lesson_3.5_Email_STARTTLS_vs_Implicit_TLS.mp4'],
        ['3.6', 'SSH: Reading a Protocol You Can’t Decrypt', '4:14', 'Every SSH packet before encryption starts, why no server key can unlock a session, and how banners, HASSH fingerprints, timing and baselines still power detections.', 'Lesson_3.6_SSH_Reading_a_Protocol_You_Cant_Decrypt.mp4']
      ]
    },
    {
      id: '4',
      title: 'Network Design and Visibility',
      duration: '20 min',
      description: 'Decryption can’t help with packets a sensor never receives. This unit is about where traffic actually flows.',
      lessons: [
        ['4.1', 'North-South vs. East-West: What Each Sensor Can See', '3:52', 'Trace one intrusion from two vantage points and see why perimeter sensors miss lateral movement. Learn to place sensors at traffic convergence points.', 'Lesson_4.1_North-South_vs_East-West_What_Each_Sensor_Can_See.mp4'],
        ['4.2', 'Getting a Clean Copy: Both Directions, No Drops, No Duplicates', '4:11', 'Asymmetric routing, oversubscribed mirrors, duplicate packets and encapsulation (VXLAN, GRE, ERSPAN): how each one breaks decryption and how to fix it.', 'Lesson_4.2_Getting_a_Clean_Copy_Both_Directions_No_Drops_No_Duplicates.mp4'],
        ['4.3', 'Branches, MPLS and SD-WAN', '4:44', 'How branch traffic flows over MPLS and SD-WAN, why you must tap the LAN side of an SD-WAN edge, and which paths, such as local DCs, branch-to-branch tunnels and internet breakout, bypass your data center sensors.', 'Lesson_4.3_Branches_MPLS_and_SD-WAN.mp4'],
        ['4.4', 'Data Centers, Colos and Virtualization', '3:43', 'Where to attach in a data center, how to see VM-to-VM traffic that never leaves a host, and what changes in colocation and VXLAN fabrics.', 'Lesson_4.4_Data_Centers_Colos_and_Virtualization.mp4'],
        ['4.5', 'Cloud Visibility: AWS, Azure and Google Cloud', '3:40', 'How each cloud mirrors packets, the limits that create blind spots, and how to keep keys and packets together on cloud sensors.', 'Lesson_4.5_Cloud_Visibility_AWS_Azure_and_Google_Cloud.mp4']
      ]
    },
    {
      id: '5',
      title: 'Choosing a Decryption Method',
      duration: '19 min',
      description: 'The four ways to get keys, and how to pick the right one for every flow.',
      lessons: [
        ['5.1', 'Four Ways to Get Keys, Side by Side', '4:59', 'Private key, load balancer secrets, server agent and domain controller integration compared on one page, with a reusable decision path and what an 85% forward-secrecy environment means in practice.', 'Lesson_5.1_Four_Ways_to_Get_Keys_Side_by_Side.mp4'],
        ['5.2', 'Load Balancer Modes: Offload, Bridging and Passthrough', '5:15', 'What’s encrypted on each side of a load balancer in each mode, which method decrypts each side, how SNAT hides the real client, and where a sensor must sit.', 'Lesson_5.2_Load_Balancer_Modes_Offload_Bridging_and_Passthrough.mp4'],
        ['5.3', 'How F5 and NetScaler Share Secrets', '4:02', 'The F5 iRule sideband design step by step, NetScaler’s built-in integration, and a clear list of what’s documented and what to confirm, including TLS 1.3, sending to multiple sensors, and Avi.', 'Lesson_5.3_How_F5_and_NetScaler_Share_Secrets.mp4'],
        ['5.4', 'Where Server Agents Make Sense', '4:44', 'The flows only an agent can cover, which platforms the session key forwarder supports, the gaps (including OpenSSL 3 on RHEL 9 and SQL Server), and the operational risks to plan for.', 'Lesson_5.4_Where_Server_Agents_Make_Sense.mp4']
      ]
    },
    {
      id: '6',
      title: 'Designing for Your Environment',
      duration: '19 min',
      description: 'Everything so far, applied to a real enterprise: perimeter coverage today, east-west next, load balancers consolidated in a few data centers, and sensors at every site.',
      lessons: [
        ['6.1', 'Your Environment as a Flow Map', '4:42', 'Sort all traffic into five flow types and work out which sensor can see each one. This map is the foundation for every design decision that follows.', 'Lesson_6.1_Your_Environment_as_a_Flow_Map.mp4'],
        ['6.2', 'Consolidated Load Balancers, Sensors Everywhere', '5:33', 'The heart of the design. Compare sending every load balancer’s secrets to every sensor (a full mesh) with decrypting at the load balancer’s own data center. Work through the trade-offs with a worked example, and learn what to confirm before committing.', 'Lesson_6.2_Consolidated_Load_Balancers_Sensors_Everywhere.mp4'],
        ['6.3', 'Microsoft Protocols Across Many Sites', '4:16', 'Which sensors need domain controller keys, the scale limits, and the security risk of every sensor holding domain-level keys. Ends with a per-site plan.', 'Lesson_6.3_Microsoft_Protocols_Across_Many_Sites.mp4'],
        ['6.4', 'A Phased Rollout for East-West', '4:01', 'A five-phase plan with a measurable exit check for each phase, plus the six questions to put to ExtraHop and your load balancer team before you scale.', 'Lesson_6.4_A_Phased_Rollout_for_East-West.mp4']
      ]
    },
    {
      id: '7',
      title: 'Hands-On Configuration',
      duration: '16 min',
      description: 'The actual settings, as ExtraHop documents them, and how to prove each one works.',
      lessons: [
        ['7.1', 'Sensor Prerequisites and Private Key Decryption', '4:19', 'Licenses and checks to complete first, uploading an RSA key, mapping protocols to ports, and how the sensor protects stored keys.', 'Lesson_7.1_Sensor_Prerequisites_and_Private_Key_Decryption.mp4'],
        ['7.2', 'Installing and Validating the Session Key Forwarder', '4:40', 'Sensor-side settings, then Windows, Linux and Java installs, including sending to multiple sensors and the Java 17 requirement. Validate in three steps.', 'Lesson_7.2_Installing_and_Validating_the_Session_Key_Forwarder.mp4'],
        ['7.3', 'Connecting a Domain Controller', '3:55', 'Preparing a least-privilege sync account, the connection settings, and how to read the Microsoft Protocol Decryption dashboard to find and fix failures.', 'Lesson_7.3_Connecting_a_Domain_Controller.mp4'],
        ['7.4', 'Validation Lab: One VIP per Mode', '3:23', 'A repeatable five-step test with a marker request for every new site, server or load balancer mode, plus a table for reading failures.', 'Lesson_7.4_Validation_Lab_One_VIP_per_Mode.mp4']
      ]
    },
    {
      id: '8',
      title: 'Operations',
      duration: '12 min',
      description: 'Running decryption safely and using it in investigations.',
      lessons: [
        ['8.1', 'Governing Keys and Decrypted Data', '3:12', 'Every place keys now live, who can reach them, and the rules that keep a decryption program defensible.', 'Lesson_8.1_Governing_Keys_and_Decrypted_Data.mp4'],
        ['8.2', 'Forensics: Packets Plus Keys', '3:41', 'Why real-time decryption isn’t enough for investigations, how to store session keys with packets, and how to open a decrypted capture in Wireshark.', 'Lesson_8.2_Forensics_Packets_Plus_Keys.mp4'],
        ['8.3', 'Troubleshooting Scenarios and Capstone', '5:06', 'Five real-world troubleshooting scenarios, a capstone exercise to design decryption for one site end to end, and next steps for your own rollout.', 'Lesson_8.3_Troubleshooting_Scenarios_and_Capstone.mp4']
      ]
    }
  ];

  function makeElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render() {
    const root = document.getElementById('training-units');
    if (!root) throw new Error('Training page is missing its lesson container.');

    units.forEach(unit => {
      const section = makeElement('section', 'training-unit panel');
      section.setAttribute('aria-labelledby', `training-unit-${unit.id}`);
      const heading = makeElement('header', 'training-unit-heading');
      const title = makeElement('h2', '', `Unit ${unit.id} · ${unit.title}`);
      title.id = `training-unit-${unit.id}`;
      const duration = makeElement('p', 'training-label', `${unit.lessons.length} lessons · ${unit.duration}`);
      const description = makeElement('p', 'training-unit-description', unit.description);
      heading.append(title, duration, description);
      section.appendChild(heading);

      const lessonList = makeElement('div', 'training-lessons');
      unit.lessons.forEach(([id, lessonTitle, length, summary, file]) => {
        const lesson = makeElement('article', 'training-lesson');
        const lessonHeading = makeElement('div', 'training-lesson-heading');
        const label = makeElement('p', 'training-label', `LESSON ${id} · ${length}`);
        const heading = makeElement('h3', '', lessonTitle);
        const blurb = makeElement('p', 'training-lesson-description', summary);
        lessonHeading.append(label, heading);
        const video = makeElement('video', 'training-video');
        video.controls = true;
        video.preload = 'none';
        video.setAttribute('aria-label', `Lesson ${id}: ${lessonTitle}`);
        const source = makeElement('source');
        source.src = `training-videos/${file}`;
        source.type = 'video/mp4';
        video.append(source);
        video.appendChild(document.createTextNode('Your browser does not support video playback.'));
        lesson.append(lessonHeading, blurb, video);
        lessonList.appendChild(lesson);
      });
      section.appendChild(lessonList);
      root.appendChild(section);
    });
  }

  window.FinanceTraining = { render, units };
  render();
})();
