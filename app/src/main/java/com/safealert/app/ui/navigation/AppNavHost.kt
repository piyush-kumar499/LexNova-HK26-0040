package com.safealert.app.ui.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.BottomNavigation
import androidx.compose.material3.BottomNavigationItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.safealert.app.R
import com.safealert.app.ui.checkin.CheckinScreen
import com.safealert.app.ui.contacts.ContactsScreen
import com.safealert.app.ui.home.HomeScreen
import com.safealert.app.ui.nearby.NearbyScreen
import com.safealert.app.ui.settings.SettingsScreen

/**
 * Navigation graph host using Navigation Compose.
 * Contains all screen destinations with bottom navigation bar.
 */
data class NavItem(
    val route: String,
    val labelRes: Int,
    val icon: ImageVector
)

@Composable
fun AppNavHost() {
    val navController = rememberNavController()
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = navBackStackEntry?.destination

    val navItems = listOf(
        NavItem(Destinations.HOME, R.string.nav_home, Icons.Default.Home),
        NavItem(Destinations.CONTACTS, R.string.nav_contacts, Icons.Default.Contacts),
        NavItem(Destinations.CHECKIN, R.string.nav_checkin, Icons.Default.CheckCircle),
        NavItem(Destinations.NEARBY, R.string.nav_nearby, Icons.Default.LocationOn),
        NavItem(Destinations.SETTINGS, R.string.nav_settings, Icons.Default.Settings)
    )

    Scaffold(
        bottomBar = {
            BottomNavigation {
                navItems.forEach { item ->
                    BottomNavigationItem(
                        icon = { Icon(item.icon, contentDescription = null) },
                        label = { Text(stringResource(item.labelRes)) },
                        selected = currentDestination?.hierarchy?.any { it.route == item.route } == true,
                        onClick = {
                            navController.navigate(item.route) {
                                popUpTo(navController.graph.findStartDestination().id) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                    )
                }
            }
        }
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = Destinations.HOME,
            modifier = Modifier.padding(innerPadding)
        ) {
            composable(Destinations.HOME) { HomeScreen() }
            composable(Destinations.CONTACTS) { ContactsScreen() }
            composable(Destinations.CHECKIN) { CheckinScreen() }
            composable(Destinations.NEARBY) { NearbyScreen() }
            composable(Destinations.SETTINGS) { SettingsScreen() }
        }
    }
}
