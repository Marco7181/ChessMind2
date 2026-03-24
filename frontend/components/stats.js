function loadStats() {
    const games = parseInt(localStorage.getItem("games") || 0);
    const wins = parseInt(localStorage.getItem("wins") || 0);
    const puzzles = parseInt(localStorage.getItem("puzzles") || 0);

    const losses = games - wins;
    const winrate = games > 0 ? Math.round((wins / games) * 100) : 0;

    document.getElementById("s-games").innerText = games;
    document.getElementById("s-wins").innerText = wins;
    document.getElementById("s-losses").innerText = losses;
    document.getElementById("s-puzzles").innerText = puzzles;
    document.getElementById("s-winrate").innerText = winrate + "%";

    drawChart(games, wins, losses);
}

// Mini grafico semplice senza librerie esterne
function drawChart(g, w, l) {
    const canvas = document.getElementById("stats-chart");
    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const max = Math.max(g, w, l, 1);

    const barWidth = 60;
    const spacing = 40;
    const baseY = 180;

    const bars = [
        { label: "Giocate", value: g, color: "#4CAF50" },
        { label: "Vinte", value: w, color: "#2196F3" },
        { label: "Perse", value: l, color: "#F44336" }
    ];

    bars.forEach((b, i) => {
        const height = (b.value / max) * 150;

        ctx.fillStyle = b.color;
        ctx.fillRect(20 + i * (barWidth + spacing), baseY - height, barWidth, height);

        ctx.fillStyle = "#fff";
        ctx.font = "14px Segoe UI";
        ctx.fillText(b.label, 20 + i * (barWidth + spacing) + barWidth / 2, baseY + 20);
        
        ctx.fillStyle = "#fff";
        ctx.font = "12px Segoe UI";
        ctx.fillText(b.value, 20 + i * (barWidth + spacing) + barWidth / 2, baseY - height - 10);
    });
}
