package com.lexnova.safety.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Navy = Color(0xFF0B0F19)
val NavyCard = Color(0xFF151B2C)
val NavyField = Color(0xFF1E2639)
val SOSEmergency = Color(0xFFE5484D)
val SOSPressed = Color(0xFF8F1D26)
val TealAccent = Color(0xFF4CC9A8)
val Amber = Color(0xFFF5B84C)
val TextPrimary = Color(0xFFEDF1F7)
val TextDim = Color(0xFF9AA4B5)
val OutlineDim = Color(0xFF2A3347)

private val DarkColors = darkColorScheme(
    primary = SOSEmergency,
    onPrimary = Color.White,
    secondary = TealAccent,
    onSecondary = Color(0xFF06231C),
    background = Navy,
    onBackground = TextPrimary,
    surface = NavyCard,
    onSurface = TextPrimary,
    surfaceVariant = NavyField,
    onSurfaceVariant = TextDim,
    error = SOSEmergency,
    onError = Color.White,
    outline = OutlineDim,
)

@Composable
fun LexNovaTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColors, content = content)
}
